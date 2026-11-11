// Screenshots of the rendered panes with headless Google Chrome. Runs after dev/render.mjs:
//
//   npm run render:png     # writes dev/out/chat-tree.png and dev/out/side-chat.png
//
// Skips the PNG files, with a message and exit 0, when Chrome is not installed.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PANES = ['chat-tree', 'side-chat'];
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dev/out');

if (!existsSync(CHROME)) {
  console.log(`Google Chrome is not at ${CHROME}. No PNG files were written.`);
  process.exit(0);
}

// A new empty profile, so the run never reads or writes the user's own Chrome profile.
const profile = mkdtempSync(join(tmpdir(), 'render-png-'));
let failed = false;
try {
  for (const id of PANES) {
    const html = join(outDir, `${id}.html`);
    const png = join(outDir, `${id}.png`);
    if (!existsSync(html)) {
      console.error(`${html} is missing. Run node dev/render.mjs first.`);
      failed = true;
      continue;
    }
    rmSync(png, { force: true });
    const result = spawnSync(
      CHROME,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--virtual-time-budget=5000',
        '--window-size=380,900',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        `--screenshot=${png}`,
        pathToFileURL(html).href,
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    if (result.status === 0 && existsSync(png) && statSync(png).size > 0) {
      console.log(`wrote ${png}`);
    } else {
      const tail = `${result.error?.message ?? ''} ${result.stderr ?? ''}`.trim().split('\n').slice(-3).join(' | ');
      console.error(`Chrome did not write ${png} (exit ${result.status}): ${tail}`);
      failed = true;
    }
  }
} finally {
  rmSync(profile, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
