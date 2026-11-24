// Minimal reproduction: what @mastra/langsmith sends for one agent turn with a tool call and thread-title generation.
// No LangSmith account or API key is needed: a local HTTP server stands in for LangSmith and records the runs.
import { createServer } from 'node:http';

import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import { LangSmithExporter } from '@mastra/langsmith';
import { Memory } from '@mastra/memory';
import { Observability } from '@mastra/observability';
import { Client } from 'langsmith';
import { z } from 'zod';

// 1. Local stand-in for the LangSmith API that records created and patched runs.
const runs = new Map();
const record = run => runs.set(run.id, { ...(runs.get(run.id) ?? {}), ...run });
const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
        const data = body ? JSON.parse(body) : {};
        if (req.method === 'POST' && req.url === '/runs') record(data);
        if (req.method === 'PATCH' && req.url.startsWith('/runs/')) record({ id: req.url.split('/')[2], ...data });
        if (req.method === 'POST' && req.url === '/runs/batch') [...(data.post ?? []), ...(data.patch ?? [])].forEach(record);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
    });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const apiUrl = `http://127.0.0.1:${server.address().port}`;
const client = new Client({ apiUrl, apiKey: 'not-used', autoBatchTracing: false });

// 2. Fake model: title prompt -> title; turn with a tool result -> answer; otherwise -> tool call.
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
const textParts = text => [
    { type: 'text-start', id: 'text' },
    { type: 'text-delta', id: 'text', delta: text },
    { type: 'text-end', id: 'text' },
    { type: 'finish', finishReason: 'stop', usage },
];
const model = {
    specificationVersion: 'v2',
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    // Thread-title generation calls doGenerate.
    doGenerate: async () => ({ content: [{ type: 'text', text: 'Paris weather' }], finishReason: 'stop', usage, warnings: [] }),
    doStream: async ({ prompt }) => {
        const text = content => (typeof content === 'string' ? content : (content ?? []).map(part => part.text ?? '').join(' '));
        const system = prompt.filter(m => m.role === 'system').map(m => text(m.content)).join(' ');
        const hasToolResult = prompt.some(m => m.role === 'tool');
        const parts = /title/i.test(system)
            ? textParts('Paris weather')
            : hasToolResult
              ? textParts('It is sunny in Paris, with a high of 24°C.')
              : [
                    { type: 'tool-call', toolCallId: 'call-1', toolName: 'getWeather', input: JSON.stringify({ city: 'Paris' }) },
                    { type: 'finish', finishReason: 'tool-calls', usage },
                ];
        return {
            stream: new ReadableStream({
                start(controller) {
                    for (const part of [{ type: 'stream-start', warnings: [] }, { type: 'response-metadata', id: 'response', modelId: 'fake-model', timestamp: new Date() }, ...parts])
                        controller.enqueue(part);
                    controller.close();
                },
            }),
        };
    },
};

// 3. Agent with one tool and memory that generates thread titles.
const getWeather = createTool({
    id: 'getWeather',
    description: 'Get the weather for a city',
    inputSchema: z.object({ city: z.string() }),
    execute: async () => ({ city: 'Paris', condition: 'sunny', highC: 24 }),
    toModelOutput: output => ({ type: 'json', value: output }),
});
const agent = new Agent({
    id: 'weather-agent',
    name: 'Weather Agent',
    instructions: 'Answer weather questions using the tools.',
    model,
    tools: { getWeather },
    memory: new Memory({ storage: new InMemoryStore(), options: { generateTitle: true } }),
});
const exporter = new LangSmithExporter({ client, apiKey: 'not-used', apiUrl, projectName: 'repro' });
const mastra = new Mastra({
    agents: { agent },
    logger: false,
    observability: new Observability({ configs: { default: { serviceName: 'repro', exporters: [exporter] } } }),
});

const result = await mastra.getAgent('agent').stream('What is the weather in Paris?', { memory: { thread: 'thread-1', resource: 'user-1' } });
for await (const _ of result.fullStream) {
    // drain the stream
}
await new Promise(resolve => setTimeout(resolve, 1500));
await exporter.flush?.();
await new Promise(resolve => setTimeout(resolve, 500));
server.close();

// 4. Report what LangSmith received.
const summarize = run => {
    const messages = run.inputs?.input ?? run.inputs?.messages;
    const roles = Array.isArray(messages) ? messages.map(m => m.role ?? m.type) : null;
    const hasToolResult = JSON.stringify(run.inputs ?? {}).includes('sunny');
    const hasToolCall = JSON.stringify(run.outputs ?? {}).includes('getWeather');
    return `${String(run.run_type).padEnd(5)} ${String(run.name).slice(0, 34).padEnd(34)} input roles=${JSON.stringify(roles)} tool result in inputs=${hasToolResult} tool call in outputs=${hasToolCall}`;
};
const all = [...runs.values()].sort((a, b) => (a.dotted_order ?? '').localeCompare(b.dotted_order ?? ''));
console.log(`LangSmith received ${all.length} runs (thread session_id set on ${all.filter(r => r.extra?.metadata?.session_id).length}):\n`);
for (const run of all.filter(r => ['llm', 'tool'].includes(r.run_type) || /inference|step/i.test(r.name))) console.log(summarize(run));
console.log('\nRuns with run_type "llm" (the runs LangSmith builds the thread trajectory from):\n');
for (const run of all.filter(r => r.run_type === 'llm')) {
    const messages = run.inputs?.input ?? run.inputs?.messages ?? [];
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const userText = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '');
    console.log(`- ${run.name}: last user message = ${JSON.stringify(userText.slice(0, 110))}${userText.length > 110 ? '…' : ''}`);
    console.log(`  output text = ${JSON.stringify(run.outputs?.text ?? run.outputs?.output ?? null)}`);
    console.log(`  output fields = ${JSON.stringify(Object.keys(run.outputs ?? {}))}`);
}
process.exit(0);
