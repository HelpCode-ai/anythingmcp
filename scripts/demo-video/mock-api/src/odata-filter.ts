/**
 * Just enough of OData `$filter` for the demo: comparisons (eq ne lt le gt ge)
 * between fields and literals or other fields, and / or / not, parentheses,
 * and substringof / startswith / endswith / contains. Anything else returns
 * null and the caller serves the unfiltered set, which is what a lenient
 * demo backend should do rather than fail on camera.
 */

type Row = Record<string, unknown>;
type Pred = (r: Row) => boolean;
type Val = (r: Row) => unknown;

interface Tok {
  t: 'id' | 'str' | 'num' | '(' | ')' | ',';
  v: string;
}

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')' || c === ',') { out.push({ t: c, v: c }); i++; continue; }
    if (c === "'") {
      let j = i + 1;
      let v = '';
      while (j < s.length) {
        if (s[j] === "'" && s[j + 1] === "'") { v += "'"; j += 2; continue; }
        if (s[j] === "'") break;
        v += s[j++];
      }
      out.push({ t: 'str', v });
      i = j + 1;
      continue;
    }
    const m = /^(-?\d+(\.\d+)?)[mMdD]?/.exec(s.slice(i));
    if (m) {
      out.push({ t: 'num', v: m[1] });
      i += m[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_/.]*/.exec(s.slice(i));
    if (!id) throw new Error(`Unexpected "${c}"`);
    out.push({ t: 'id', v: id[0] });
    i += id[0].length;
  }
  return out;
}

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : NaN);

function compare(op: string, a: unknown, b: unknown): boolean {
  const na = num(a);
  const nb = num(b);
  const bothNum = !isNaN(na) && !isNaN(nb);
  const x = bothNum ? na : String(a ?? '').toLowerCase();
  const y = bothNum ? nb : String(b ?? '').toLowerCase();
  switch (op) {
    case 'eq': return x === y;
    case 'ne': return x !== y;
    case 'lt': return x < y;
    case 'le': return x <= y;
    case 'gt': return x > y;
    case 'ge': return x >= y;
  }
  return false;
}

export function parseFilter(src: string): Pred | null {
  let toks: Tok[];
  try {
    toks = tokenize(src);
  } catch {
    return null;
  }
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = (t: Tok['t']) => {
    const k = next();
    if (!k || k.t !== t) throw new Error(`Expected ${t}`);
    return k;
  };

  const value = (): Val => {
    const k = next();
    if (!k) throw new Error('Unexpected end');
    if (k.t === 'str') return () => k.v;
    if (k.t === 'num') return () => Number(k.v);
    if (k.t === 'id') {
      if (k.v === 'true' || k.v === 'false') return () => k.v === 'true';
      if (k.v === 'null') return () => null;
      const fn = k.v.toLowerCase();
      if (peek()?.t === '(' && ['substringof', 'startswith', 'endswith', 'contains', 'tolower', 'toupper'].includes(fn)) {
        next();
        const a = value();
        if (fn === 'tolower' || fn === 'toupper') {
          expect(')');
          return (r) => String(a(r) ?? '').toLowerCase();
        }
        expect(',');
        const b = value();
        expect(')');
        return (r) => {
          const x = String(a(r) ?? '').toLowerCase();
          const y = String(b(r) ?? '').toLowerCase();
          if (fn === 'substringof') return y.includes(x);
          if (fn === 'startswith') return x.startsWith(y);
          if (fn === 'endswith') return x.endsWith(y);
          return x.includes(y);
        };
      }
      return (r) => r[k.v];
    }
    if (k.t === '(') {
      const inner = orExpr();
      expect(')');
      return inner;
    }
    throw new Error('Unexpected token');
  };

  const cmp = (): Pred => {
    if (peek()?.t === 'id' && peek()!.v === 'not') {
      next();
      const inner = cmp();
      return (r) => !inner(r);
    }
    const left = value();
    const op = peek();
    if (op?.t === 'id' && /^(eq|ne|lt|le|gt|ge)$/.test(op.v)) {
      next();
      const right = value();
      return (r) => compare(op.v, left(r), right(r));
    }
    return (r) => left(r) === true;
  };

  const andExpr = (): Pred => {
    let left = cmp();
    while (peek()?.t === 'id' && peek()!.v === 'and') {
      next();
      const l = left;
      const right = cmp();
      left = (r) => l(r) && right(r);
    }
    return left;
  };

  function orExpr(): Pred {
    let left = andExpr();
    while (peek()?.t === 'id' && peek()!.v === 'or') {
      next();
      const l = left;
      const right = andExpr();
      left = (r) => l(r) || right(r);
    }
    return left;
  }

  try {
    const pred = orExpr();
    if (p !== toks.length) return null;
    return pred;
  } catch {
    return null;
  }
}
