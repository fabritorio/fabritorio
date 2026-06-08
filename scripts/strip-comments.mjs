// AST-based comment stripper. Removes all comments except tooling directives,
// using the TypeScript parser so string/template/regex/JSX content is never
// touched. Run on a branch; git holds the originals. oxfmt cleans whitespace
// residue afterward.
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

const SCAN_DIRS = [
    'apps/runner/src',
    'apps/runner/test',
    'apps/web/app',
    'apps/web/components',
    'apps/web/lib',
    'apps/web/test',
    'packages/types/src',
];

// Security / egress carve-out — threat-model comments stay. Repo-relative.
const EXCLUDE = new Set([
    'apps/runner/src/runtime/security-hooks.ts',
    'apps/runner/src/runtime/token.ts',
    'apps/runner/src/config.ts',
    'apps/runner/src/index.ts',
    'apps/runner/src/runtime/web-fetch-tool.ts',
    'apps/runner/src/runtime/web-search-tool.ts',
    'apps/runner/src/runtime/agents/handler-from-l1.ts',
]);

// Comments matching these are load-bearing to tooling — never remove.
const PRESERVE =
    /@ts-(expect-error|ignore|nocheck)|eslint-(disable|enable)|oxlint-disable|biome-ignore|@__PURE__|@__NO_SIDE_EFFECTS__|prettier-ignore|(c8|v8|istanbul)\s+ignore|@jsx|\/\s*<reference|@license|@preserve|tslint:|^#!/;

const IGNORE_DIRS = new Set(['node_modules', 'dist', 'out', '.next', '.turbo']);

function walk(dir, acc) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!IGNORE_DIRS.has(entry.name)) walk(path.join(dir, entry.name), acc);
        } else if (/\.tsx?$/.test(entry.name)) {
            acc.push(path.join(dir, entry.name));
        }
    }
    return acc;
}

function collectComments(text, sourceFile) {
    const seen = new Map();
    const add = (arr) => {
        if (arr) for (const r of arr) seen.set(r.pos, r);
    };
    const visit = (node) => {
        add(ts.getLeadingCommentRanges(text, node.getFullStart()));
        add(ts.getTrailingCommentRanges(text, node.getEnd()));
        node.forEachChild(visit);
    };
    visit(sourceFile);
    return [...seen.values()];
}

// Expand a comment range to a deletion interval, computed against ORIGINAL text:
// a comment alone on its line(s) takes the whole line(s); an inline trailing
// comment takes only itself plus the preceding whitespace.
function deletionInterval(text, r) {
    const lineStart = text.lastIndexOf('\n', r.pos - 1) + 1;
    let lineEnd = text.indexOf('\n', r.end);
    if (lineEnd === -1) lineEnd = text.length;
    const before = text.slice(lineStart, r.pos);
    const after = text.slice(r.end, lineEnd);
    if (before.trim() === '' && after.trim() === '') {
        // whole-line (or whole block-line span): drop the line and its newline
        return [lineStart, lineEnd + 1];
    }
    // inline: eat preceding whitespace back to the code, keep the newline
    let start = r.pos;
    while (start > lineStart && /\s/.test(text[start - 1])) start--;
    return [start, r.end];
}

function mergeIntervals(intervals) {
    intervals.sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const iv of intervals) {
        const last = out[out.length - 1];
        if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
        else out.push(iv.slice());
    }
    return out;
}

function strip(file) {
    const text = fs.readFileSync(file, 'utf8');
    const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
    const comments = collectComments(text, sf).filter(
        (r) => !PRESERVE.test(text.slice(r.pos, r.end)),
    );
    if (comments.length === 0) return 0;
    const intervals = mergeIntervals(comments.map((r) => deletionInterval(text, r)));
    let out = text;
    for (let i = intervals.length - 1; i >= 0; i--) {
        out = out.slice(0, intervals[i][0]) + out.slice(intervals[i][1]);
    }
    out = out.replace(/\n{3,}/g, '\n\n');
    if (out !== text) fs.writeFileSync(file, out);
    return comments.length;
}

let files = [];
for (const d of SCAN_DIRS) walk(path.join(ROOT, d), files);
files = files
    .map((f) => path.relative(ROOT, f))
    .filter((f) => !EXCLUDE.has(f))
    .sort();

let totalFiles = 0;
let totalComments = 0;
for (const f of files) {
    const n = strip(f);
    if (n > 0) {
        totalFiles++;
        totalComments += n;
    }
}
console.log(
    `stripped ${totalComments} comments from ${totalFiles} files (${files.length} scanned, ${EXCLUDE.size} carved out)`,
);
