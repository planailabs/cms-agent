// Minimal stdio MCP server for the custom-MCP tests — dependency-free so it
// runs inside the bwrap jail (only node:readline). Tools: echo (round-trip)
// and env (returns its process env — proves jail isolation).
import readline from 'node:readline';

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result });
  if (msg.method === 'initialize') {
    reply({
      protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'echo', version: '1.0.0' },
    });
  } else if (msg.method === 'ping') {
    reply({});
  } else if (msg.method === 'tools/list') {
    reply({
      tools: [
        {
          name: 'echo',
          description: 'Echo back the input.',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        },
        {
          name: 'env',
          description: 'Return the process environment as JSON.',
          inputSchema: { type: 'object' },
        },
      ],
    });
  } else if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params ?? {};
    const text =
      name === 'echo' ? `echo:${args?.text ?? ''}` : JSON.stringify(process.env);
    reply({ content: [{ type: 'text', text }] });
  } else if (msg.id !== undefined) {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: `method not found: ${msg.method}` },
    });
  }
});
