# Mastra + LangSmith: trajectory misses tool results and shows title generation as conversation

Minimal reproduction for `@mastra/langsmith`. LangSmith builds a thread's trajectory (the Trajectory view and the
`trajectory` variable of multi-turn online evaluators) from runs with `run_type: "llm"`. For a Mastra agent turn that
calls a tool:

1. The only `llm` run for the turn (`MODEL_GENERATION`) has the system and user messages as input and the final answer as
   output. The tool result is not on any `llm` run. It is only on the `inference: N` runs (`MODEL_INFERENCE`), which the
   exporter sends as `chain` runs.
2. Thread-title generation (`Memory` with `generateTitle: true`) is sent as another `llm` run in the same thread. Its
   input is a transcript ("User: ... Tool Result ... Assistant: ...") and its output is the title, so the trajectory
   shows it as an extra user/assistant exchange.

No LangSmith account or API key is needed. The script points a `langsmith` `Client` at a local HTTP server that records
the runs the exporter sends. The model is a fake `LanguageModelV2`.

## Run

```sh
npm install   # or pnpm install
npm start
```

Requires Node.js 22.13 or later. Tested with `@mastra/core` 1.85.0, `@mastra/langsmith` 1.4.5,
`@mastra/observability` 1.24.2, `@mastra/memory` 1.41.2 and `langsmith` 0.11.8.

## Output

```text
LangSmith received 23 runs (thread session_id set on 23):

llm   llm: 'fake-model'                  input roles=["system","user"] tool result in inputs=false tool call in outputs=true
chain step: 0                            input roles=null tool result in inputs=false tool call in outputs=true
chain inference: 0                       input roles=["system","user"] tool result in inputs=false tool call in outputs=true
tool  tool: 'getWeather'                 input roles=null tool result in inputs=false tool call in outputs=false
chain step: 1                            input roles=null tool result in inputs=false tool call in outputs=false
chain inference: 1                       input roles=["system","user","assistant","tool"] tool result in inputs=true tool call in outputs=false
llm   llm: 'fake-model'                  input roles=["system","user"] tool result in inputs=true tool call in outputs=false
chain step: 0                            input roles=null tool result in inputs=false tool call in outputs=false
chain inference: 0                       input roles=["system","user"] tool result in inputs=true tool call in outputs=false

Runs with run_type "llm" (the runs LangSmith builds the thread trajectory from):

- llm: 'fake-model': last user message = "[{\"type\":\"text\",\"text\":\"What is the weather in Paris?\", ..."
  output text = "It is sunny in Paris, with a high of 24°C."
  output fields = ["files","reasoning","sources","text","warnings","toolCalls"]
- llm: 'fake-model': last user message = "[{\"type\":\"text\",\"text\":\"User: What is the weather in Paris?\nTool Result getWeather: {...}"
  output text = "Paris weather"
  output fields = ["files","reasoning","sources","text","warnings"]
```

The second `llm` run is the thread-title generation. Its input contains the tool result only as text inside the
transcript.

## Expected

- The trajectory for the turn shows the user message, the tool call, the tool result and the answer.
- Internal model calls that are not part of the conversation, such as thread-title generation, do not appear in the
  trajectory.
