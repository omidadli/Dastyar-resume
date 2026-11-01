#!/usr/bin/env node
/**
 * A minimal SMTP sink for local demos: it accepts any login (AUTH PLAIN/LOGIN)
 * and prints the messages it receives instead of delivering them.
 *
 *   node scripts/mock-smtp.mjs --port 2525
 *
 * Then in «تنظیمات ← اتصال‌ها ← ایمیل سازمان»: host 127.0.0.1, port 2525,
 * secure off, any username, any password, any sender address.
 * Real mail is never sent — nothing leaves this machine.
 */
import net from 'net';

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = Number(portArg >= 0 ? args[portArg + 1] : process.env.PORT) || 2525;

let count = 0;

net
  .createServer((socket) => {
    let buffer = '';
    let inData = false;
    let data = '';
    socket.write('220 mock-smtp.local ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      for (;;) {
        const idx = buffer.indexOf('\r\n');
        if (idx < 0) break;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            count++;
            const headers = data.split('\r\n\r\n')[0] || '';
            const to = /^To:\s*(.+)$/im.exec(headers)?.[1] || '?';
            const subject = /^Subject:\s*(.+)$/im.exec(headers)?.[1] || '?';
            console.log(`\n[mock-smtp] #${count} → ${to}\n  subject: ${subject}\n  size: ${data.length} bytes — not delivered (local sink)`);
            data = '';
            socket.write('250 2.0.0 queued\r\n');
          } else {
            data += `${line}\r\n`;
          }
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') socket.write('250-mock-smtp.local\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
        else if (cmd === 'HELO') socket.write('250 mock-smtp.local\r\n');
        else if (cmd === 'AUTH') socket.write('235 2.7.0 accepted\r\n');
        else if (cmd === 'MAIL' || cmd === 'RCPT' || cmd === 'RSET' || cmd === 'NOOP') socket.write('250 2.1.0 OK\r\n');
        else if (cmd === 'DATA') {
          inData = true;
          socket.write('354 end with <CRLF>.<CRLF>\r\n');
        } else if (cmd === 'QUIT') {
          socket.write('221 2.0.0 bye\r\n');
          socket.end();
        } else socket.write('250 OK\r\n');
      }
    });
    socket.on('error', () => undefined);
  })
  .listen(PORT, '127.0.0.1', () => console.log(`[mock-smtp] listening on 127.0.0.1:${PORT} — messages are printed, never delivered`));
