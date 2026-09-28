// MCP の stdio トランスポートは stdout を JSON-RPC 専用として使う。
// console.log / info / debug / trace がそのまま stdout に書かれると通信が壊れるので、
// これらを stderr 出力に差し替える。process.stdout.write 自体は transport が使うため触らない。
// main.ts が最初に import すること。二重 import されても安全（冪等）。

const GUARD_FLAG = Symbol.for('claude-slack-channel.stdio-guard.installed');
const globalWithFlag = globalThis as typeof globalThis & {
  [GUARD_FLAG]?: boolean;
};

if (!globalWithFlag[GUARD_FLAG]) {
  const toStderr =
    (): ((...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      console.error(...args);
    };

  console.log = toStderr();
  console.info = toStderr();
  console.debug = toStderr();
  console.trace = toStderr();

  globalWithFlag[GUARD_FLAG] = true;
}

export {};
