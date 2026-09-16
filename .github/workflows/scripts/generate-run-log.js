'use strict';
// Builds two artifacts from the raw Claude Code stream-json event log:
//   - claude-output.log : plain-text transcript (fallback / quick view)
//   - claude-run-log.md : detailed Markdown report of how Claude analyzed
//                          and implemented the requirements (prompt used,
//                          each reasoning/tool-call step, files touched,
//                          and the final result)
const fs = require('fs');

const cid = process.env.CID || 'auto';
const model = process.env.MODEL || 'sonnet';
const effort = process.env.EFFORT || 'medium';
const jsonlPath = 'claude-run.jsonl';
const textLogPath = 'claude-output.log';
const mdLogPath = 'claude-run-log.md';
const promptPath = 'prompt.txt';

const prompt = fs.existsSync(promptPath)
  ? fs.readFileSync(promptPath, 'utf8')
  : '(prompt file not found)';

let lines = [];
if (fs.existsSync(jsonlPath)) {
  lines = fs.readFileSync(jsonlPath, 'utf8')
    .split('\n')
    .map(function (l) { return l.trim(); })
    .filter(Boolean);
}

const events = [];
const textOut = [];
for (const line of lines) {
  try {
    events.push(JSON.parse(line));
  } catch (e) {
    textOut.push(line);
  }
}

const steps = [];
const filesTouched = new Set();
let finalResult = null;
let sessionId = null;
let usage = null;
let isError = false;
let durationMs = null;
let numTurns = null;

function toolInputSummary(name, input) {
  if (!input) return '';
  if (input.file_path) return input.file_path;
  if (input.path) return input.path;
  if (input.command) return input.command;
  if (input.pattern) return input.pattern;
  if (input.url) return input.url;
  if (input.query) return input.query;
  try {
    const s = JSON.stringify(input);
    return s.length > 200 ? s.slice(0, 200) + '...' : s;
  } catch (e) {
    return '';
  }
}

for (const ev of events) {
  if (ev.type === 'system' && ev.subtype === 'init') {
    sessionId = ev.session_id || sessionId;
  }

  if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    for (const block of ev.message.content) {
      if (block.type === 'text' && block.text && block.text.trim()) {
        steps.push({ kind: 'reasoning', text: block.text.trim() });
        textOut.push(block.text.trim());
      } else if (block.type === 'tool_use') {
        const summary = toolInputSummary(block.name, block.input);
        steps.push({ kind: 'tool_call', name: block.name, summary: summary, input: block.input });
        textOut.push('[tool] ' + block.name + (summary ? ': ' + summary : ''));
        if (block.input) {
          const p = block.input.file_path || block.input.path;
          if (p && (block.name === 'Write' || block.name === 'Edit' || block.name === 'NotebookEdit')) {
            filesTouched.add(p);
          }
        }
      }
    }
  }

  if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
    for (const block of ev.message.content) {
      if (block.type === 'tool_result') {
        let resultText = '';
        if (typeof block.content === 'string') {
          resultText = block.content;
        } else if (Array.isArray(block.content)) {
          resultText = block.content
            .filter(function (c) { return c.type === 'text'; })
            .map(function (c) { return c.text; })
            .join('\n');
        }
        if (resultText) {
          const trimmed = resultText.length > 500 ? resultText.slice(0, 500) + '...' : resultText;
          steps.push({ kind: 'tool_result', text: trimmed, isError: !!block.is_error });
          textOut.push('[result] ' + trimmed);
        }
      }
    }
  }

  if (ev.type === 'result') {
    finalResult = ev.result || null;
    isError = !!ev.is_error;
    durationMs = ev.duration_ms || null;
    numTurns = ev.num_turns || null;
    usage = ev.usage || null;
    sessionId = ev.session_id || sessionId;
    if (finalResult) textOut.push(finalResult);
  }
}

fs.writeFileSync(textLogPath, textOut.join('\n') + '\n', 'utf8');

const md = [];
md.push('# Claude Run Log');
md.push('');
md.push('- **Correlation ID:** ' + cid);
md.push('- **Model:** ' + model);
md.push('- **Effort:** ' + effort);
if (sessionId) md.push('- **Session ID:** ' + sessionId);
if (numTurns !== null) md.push('- **Turns:** ' + numTurns);
if (durationMs !== null) md.push('- **Duration:** ' + (durationMs / 1000).toFixed(1) + 's');
md.push('- **Status:** ' + (isError ? 'Error' : 'Success'));
if (usage) {
  md.push('- **Token usage:** input=' + (usage.input_tokens != null ? usage.input_tokens : '?') +
    ', output=' + (usage.output_tokens != null ? usage.output_tokens : '?') +
    (usage.cache_read_input_tokens ? ', cache_read=' + usage.cache_read_input_tokens : '') +
    (usage.cache_creation_input_tokens ? ', cache_creation=' + usage.cache_creation_input_tokens : ''));
}
md.push('');

md.push('## Requirement / Prompt Given to Claude');
md.push('');
md.push('```');
md.push(prompt.trim());
md.push('```');
md.push('');
md.push('## Step-by-Step Implementation Log');
md.push('');
if (steps.length === 0) {
  md.push('_No structured steps were captured (stream-json events not found or empty)._');
} else {
  let stepNum = 0;
  for (const s of steps) {
    if (s.kind === 'reasoning') {
      stepNum++;
      md.push('### ' + stepNum + '. Reasoning');
      md.push('');
      md.push(s.text);
      md.push('');
    } else if (s.kind === 'tool_call') {
      stepNum++;
      md.push('### ' + stepNum + '. Tool call: `' + s.name + '`');
      md.push('');
      if (s.summary) md.push('**Target:** `' + s.summary + '`');
      md.push('');
      md.push('<details><summary>Full input</summary>');
      md.push('');
      md.push('```json');
      try {
        md.push(JSON.stringify(s.input, null, 2));
      } catch (e) {
        md.push('(unserializable input)');
      }
      md.push('```');
      md.push('');
      md.push('</details>');
      md.push('');
    } else if (s.kind === 'tool_result') {
      md.push('**' + (s.isError ? 'Result (error)' : 'Result') + ':**');
      md.push('');
      md.push('```');
      md.push(s.text);
      md.push('```');
      md.push('');
    }
  }
}

md.push('## Files Created or Modified');
md.push('');
if (filesTouched.size === 0) {
  md.push('_No file-writing tool calls were captured._');
} else {
  Array.from(filesTouched).sort().forEach(function (f) {
    md.push('- `' + f + '`');
  });
}
md.push('');

md.push('## Final Result');
md.push('');
md.push('```');
md.push(finalResult ? finalResult.trim() : '(no final result captured)');
md.push('```');
md.push('');

fs.writeFileSync(mdLogPath, md.join('\n'), 'utf8');

console.log('[cid:' + cid + '] Wrote ' + textLogPath + ' and ' + mdLogPath + ' (' + steps.length + ' step(s), ' + filesTouched.size + ' file(s) touched).');
