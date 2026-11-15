/**
 * Web shell. Connects to a bash process that runs as the agent user in the
 * run's workspace, the same environment Claude works in.
 */
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';

export function Terminal({ runId }: { runId?: string }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const terminal = new XTerm({ fontSize: 13, cursorBlink: true, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', theme: { background: '#11151c' } });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container.current!);

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${window.location.host}/api/shell${runId ? `?runId=${runId}` : ''}`);
    const send = (message: object) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message));
    const resize = () => {
      fit.fit();
      send({ type: 'resize', cols: terminal.cols, rows: terminal.rows });
    };

    socket.onopen = resize;
    socket.onmessage = (message) => terminal.write(message.data as string);
    socket.onclose = () => terminal.write('\r\n\x1b[2m[shell closed]\x1b[0m\r\n');
    const input = terminal.onData((data) => send({ type: 'input', data }));
    window.addEventListener('resize', resize);

    return () => {
      window.removeEventListener('resize', resize);
      input.dispose();
      socket.close();
      terminal.dispose();
    };
  }, [runId]);

  return <div className="terminal" ref={container} />;
}
