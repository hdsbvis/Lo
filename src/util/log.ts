const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  red: wrap('31'), green: wrap('32'), yellow: wrap('33'), blue: wrap('34'),
  magenta: wrap('35'), cyan: wrap('36'), grey: wrap('90'), bold: wrap('1'),
  bgRed: wrap('41;97;1'), bgYellow: wrap('43;30;1'), bgGreen: wrap('42;30;1'),
};

let verbose = false;
export const setVerbose = (v: boolean) => { verbose = v; };

export const log = {
  info: (...a: unknown[]) => console.error(...a),
  debug: (...a: unknown[]) => { if (verbose) console.error(c.grey('[debug]'), ...a); },
  warn: (...a: unknown[]) => console.error(c.yellow('[warn]'), ...a),
  error: (...a: unknown[]) => console.error(c.red('[error]'), ...a),
  /** Results go to stdout so they can be piped; diagnostics go to stderr. */
  out: (...a: unknown[]) => console.log(...a),
};
