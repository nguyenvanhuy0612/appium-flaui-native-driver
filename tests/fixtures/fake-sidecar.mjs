// Stands in for the C# exe in TS unit tests: prints PORT=, serves /status, exits on stdin EOF.
import http from 'node:http';

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/status') {
    res.end(JSON.stringify({ ok: true, ready: true }));
    return;
  }
  if (req.url === '/__die') {
    // test hook: simulate the sidecar self-exiting / crashing on its own (NOT via stdin/stop()).
    res.end(JSON.stringify({ ok: true, value: {} }));
    setTimeout(() => process.exit(0), 10);
    return;
  }
  res.end(JSON.stringify({ ok: true, value: {} }));
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`PORT=${server.address().port}\n`);
});

process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
