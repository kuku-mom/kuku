// Real WKWebView smoke test using WebdriverIO's embedded W3C driver.
// All notes and settings live in an isolated temporary directory. No provider
// connections are enabled and no OAuth or EventKit permission flow is invoked.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

if (process.platform !== 'darwin')
  throw new Error('This native smoke runner targets macOS WKWebView');
const liveModelOnly = process.argv.includes('--live-model-only');
const liveModel = process.argv.includes('--live-model') || liveModelOnly;
if (
  liveModel &&
  (process.argv.includes('--probe-only') || process.argv.includes('--controls-only'))
)
  throw new Error('--live-model requires the complete smoke run');
if (liveModel && process.env.KUKU_SMOKE_VERBOSE)
  throw new Error('Disable KUKU_SMOKE_VERBOSE before using the configured live model');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktop = path.join(root, 'apps/desktop');
const config = await readFile(path.join(desktop, 'src-tauri/tauri.native-smoke.conf.json'), 'utf8');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'kuku-native-planner-'));
const data = path.join(scratch, 'app-data');
const vault = path.join(scratch, 'vault');
const nativeNote =
  '# Native planner smoke\n\n- [ ] Native drag task\n- [ ] Zebra native task\n- [ ] Alpha native task\n';
const smokeDate = new Date();
smokeDate.setDate(smokeDate.getDate() + 14 - ((smokeDate.getDay() + 6) % 7));
const anchorDay = `${smokeDate.getFullYear()}-${String(smokeDate.getMonth() + 1).padStart(2, '0')}-${String(smokeDate.getDate()).padStart(2, '0')}`;
await mkdir(path.join(data, 'plugins/planner'), { recursive: true });
await mkdir(vault, { recursive: true });
await writeFile(path.join(vault, 'Native.md'), nativeNote);
await writeFile(
  path.join(data, 'settings.json'),
  JSON.stringify({
    last_opened_vault: vault,
    disabled_plugins: ['meeting-notes', 'knowledge', 'voxel-graph'],
    appearance: { language: 'en', theme: 'light' },
    general: { auto_save: true },
  }),
);
await writeFile(
  path.join(data, 'plugins/planner/settings.json'),
  JSON.stringify({
    enabledSources: { google: false, 'apple-calendar': false, 'apple-reminders': false },
    selectedCalendars: { google: [], 'apple-calendar': [], 'apple-reminders': [] },
    excludedFolders: [],
    defaultCalendar: null,
  }),
);
const children = [];
let nativePid;
let nativeExecutable;
let nativeApp;
let reopenedForVisibility = false;
const nativeLog = path.join(scratch, 'app.log');
const execFileAsync = promisify(execFile);
const output = [];
let session;
let driver;
let providerStatus;
let aiEvidence;
let liveEvidence;
const liveSessions = new Set();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function launch(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      output.push(String(chunk));
      if (process.env.KUKU_SMOKE_VERBOSE) process.stdout.write(chunk);
    });
  return child;
}
async function run(command, args, options) {
  const child = launch(command, args, options);
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(`${command} exited ${code}: ${output.slice(-10).join('')}`);
}
async function waitUntil(check, message, timeout = 45000) {
  const until = Date.now() + timeout;
  let error;
  while (Date.now() < until) {
    try {
      const value = await check();
      if (value) return value;
    } catch (caught) {
      if (/SyntaxError/.test(caught.message)) throw caught;
      error = caught;
    }
    await delay(150);
  }
  throw new Error(`${message}${error ? `: ${error.message}` : ''}`);
}
async function freePort(port = 0) {
  const server = net.createServer();
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const value = server.address().port;
  server.close();
  await once(server, 'close');
  return value;
}
async function testProcessPid() {
  const { stdout } = await execFileAsync('/bin/ps', ['-Ao', 'pid=,comm=']);
  const process = stdout
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
    .find((match) => match?.[2] === nativeExecutable);
  return process ? Number(process[1]) : undefined;
}
async function verifyNativePaint() {
  const initial = await execute(
    'return {visibility:document.visibilityState,focused:document.hasFocus()};',
  );
  if (initial.visibility !== 'visible' && !reopenedForVisibility) {
    assert.ok(
      nativeApp && nativePid && (await testProcessPid()) === nativePid,
      'Only the existing isolated smoke process may be reopened',
    );
    reopenedForVisibility = true;
    // Reopen the known running app through LaunchServices. Its normal Tauri
    // RunEvent::Reopen handler shows/focuses its own window. No new process or
    // native automation; do not loop if the OS still occludes the window.
    await run('/usr/bin/open', [nativeApp]);
    const visible = await waitUntil(
      () => execute('return document.visibilityState === "visible"'),
      'The isolated test window stayed hidden after reopening',
      10000,
    ).catch(() => false);
    await writeFile(
      path.join(scratch, 'native-reopen.json'),
      JSON.stringify(
        {
          initial,
          processId: nativePid,
          visible,
          after: await execute(
            'return {visibility:document.visibilityState,focused:document.hasFocus()};',
          ),
        },
        null,
        2,
      ),
    );
  }
  await execute(
    'window.__plannerPaintFrames=0; requestAnimationFrame(()=>{window.__plannerPaintFrames++; requestAnimationFrame(()=>window.__plannerPaintFrames++);}); return true;',
  );
  const painted = await waitUntil(
    () => execute('return window.__plannerPaintFrames === 2'),
    'Native WKWebView did not render animation frames',
    5000,
  ).catch(() => false);
  const diagnostic = await execute(
    'return {visibility:document.visibilityState,focused:document.hasFocus(),frames:window.__plannerPaintFrames,width:innerWidth,height:innerHeight,userAgent:navigator.userAgent}',
  );
  await writeFile(path.join(scratch, 'native-paint.json'), JSON.stringify(diagnostic, null, 2));
  console.log('Native rendering probe', diagnostic);
  assert.equal(diagnostic.visibility, 'visible', 'Native test window must be visible');
  assert.ok(painted, 'Native frame barrier must advance; do not substitute DOM-only evidence');
}
async function request(method, endpoint, body, timeoutMs = 20000) {
  let response;
  try {
    response = await fetch(`${driver}${endpoint}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(
      `${method} ${endpoint} failed${body?.script ? ` (${body.script.slice(0, 120)})` : ''}`,
      { cause: error },
    );
  }
  const result = await response.json();
  if (!response.ok || result.value?.error) throw new Error(JSON.stringify(result.value ?? result));
  return result.value;
}
const execute = (script, ...args) =>
  request('POST', `/session/${session}/execute/sync`, { script, args });
async function nativeInvoke(command, args = {}, timeoutMs = 20000) {
  const result = await request(
    'POST',
    `/session/${session}/execute/async`,
    {
      script:
        'const done=arguments[arguments.length-1]; window.__TAURI__.core.invoke(arguments[0],arguments[1]).then(value=>done({value}),error=>done({error:String(error)}));',
      args: [command, args],
    },
    timeoutMs,
  );
  if (result.error) throw new Error(`${command}: ${result.error}`);
  return result.value;
}
const setValue = (selector, value) =>
  execute(
    'const e=document.querySelector(arguments[0]); if(!e) throw new Error("Input missing"); e.value=arguments[1]; e.dispatchEvent(new Event("input",{bubbles:true})); e.dispatchEvent(new Event("change",{bubbles:true})); return true;',
    selector,
    value,
  );
async function element(selector) {
  const found = await request('POST', `/session/${session}/element`, {
    using: 'css selector',
    value: selector,
  });
  return found['element-6066-11e4-a52e-4f735466cecf'];
}
async function click(selector) {
  for (let attempt = 0; ; attempt++) {
    const id = await element(selector);
    try {
      await request('POST', `/session/${session}/element/${id}/click`, {});
      return;
    } catch (error) {
      if (attempt >= 2 || !error.message.includes('stale element reference')) throw error;
      await delay(50);
    }
  }
}
async function type(selector, value) {
  const id = await element(selector);
  await request('POST', `/session/${session}/element/${id}/value`, {
    text: value,
    value: [...value],
  });
}
async function dispatchPointer(type, point, buttons) {
  // WDIO embedded 1.3.0 implements W3C pointer actions with MouseEvent only.
  // Exercise production PointerEvent handlers in the real WKWebView directly;
  // do not claim this is OS-level input injection or change the product handlers.
  return execute(
    `
    const el = document.elementFromPoint(arguments[1], arguments[2]);
    if (!el) throw new Error('Pointer target is outside the WebView');
    el.dispatchEvent(new PointerEvent(arguments[0], {
      bubbles:true, cancelable:true, pointerId:1, pointerType:'mouse', isPrimary:true,
      clientX:arguments[1], clientY:arguments[2], button:0, buttons:arguments[3]
    })); return true;`,
    type,
    Math.round(point.x),
    Math.round(point.y),
    buttons,
  );
}
async function pointer(from, to = from) {
  await dispatchPointer('pointerdown', from, 1);
  await dispatchPointer('pointermove', to, 1);
  await delay(100);
  await dispatchPointer('pointerup', to, 0);
}
async function pointerClick(selector) {
  const point = await execute(
    'const e=document.querySelector(arguments[0]); if (!e) throw new Error("Pointer target missing"); const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};',
    selector,
  );
  await dispatchPointer('pointerdown', point, 1);
  await delay(50);
  await dispatchPointer('pointerup', point, 0);
}
const dialogVisible = () => execute('return !!document.querySelector("dialog[open]")');
const selectMenuVisible = () =>
  execute(
    'return !!document.querySelector(".planner-select-content[data-expanded] [role=listbox]")',
  );
const pressKey = (key) =>
  execute(
    'const target=document.activeElement ?? document.body; for (const type of ["keydown","keyup"]) target.dispatchEvent(new KeyboardEvent(type, {key:arguments[0],bubbles:true,cancelable:true})); return true;',
    key,
  );
async function position(dayIndex, minute) {
  return execute(
    `const columns = [...document.querySelectorAll('.planner-day-column[data-planner-day]')];
    const r = columns[arguments[0]].getBoundingClientRect();
    return {x: r.left + r.width / 2, y: r.top + arguments[1] * 0.8, day: columns[arguments[0]].dataset.plannerDay};`,
    dayIndex,
    minute,
  );
}
async function verifySearchAndDateJump() {
  await type('input[type="search"][aria-label="Search tasks"]', 'native drag');
  await waitUntil(
    () =>
      execute(
        'return document.querySelectorAll(".planner-list-scroll .planner-task").length === 1',
      ),
    'Task search did not filter the local tasks',
  );
  assert.equal(
    await execute(
      'return document.querySelector(".planner-list-scroll .planner-task-title").textContent',
    ),
    'Native drag task',
  );
  await pressKey('Escape');
  await waitUntil(
    () =>
      execute(
        'return document.querySelectorAll(".planner-list-scroll .planner-task").length === 3',
      ),
    'Escape did not clear task search',
  );
  await pointerClick('[role="combobox"][aria-label="Sort tasks"]');
  await waitUntil(selectMenuVisible, 'Task sort menu did not open');
  await pointerClick('.planner-select-content [role="option"]:nth-child(3)');
  await waitUntil(async () => !(await selectMenuVisible()), 'Task sort menu did not close');
  assert.deepEqual(
    await execute(
      'return [...document.querySelectorAll(".planner-list-scroll .planner-task-title")].map(e=>e.textContent)',
    ),
    ['Alpha native task', 'Native drag task', 'Zebra native task'],
  );
  await click('.planner-date-trigger');
  await waitUntil(
    () => execute('return !!document.querySelector(".planner-date-popup[data-expanded]")'),
    'Date shortcut did not open',
  );
  await verifyNativePaint();
  const dateBounds = await execute(
    `const e=document.querySelector('.planner-date-popup'), p=document.querySelector('.planner-main'), field=e.querySelector('input[type=date]'), today=e.querySelector('.planner-date-today'); const r=e.getBoundingClientRect(), pr=p.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,pane:{left:pr.left,right:pr.right,top:pr.top,bottom:pr.bottom},fieldBottom:field.getBoundingClientRect().bottom,todayBottom:today.getBoundingClientRect().bottom};`,
  );
  assert.ok(dateBounds.left >= dateBounds.pane.left && dateBounds.right <= dateBounds.pane.right);
  assert.ok(
    dateBounds.fieldBottom <= dateBounds.bottom && dateBounds.todayBottom <= dateBounds.bottom,
    'Date entry and Today must fit in the popup',
  );
  const jump = new Date(`${anchorDay}T12:00:00`);
  jump.setDate(jump.getDate() + 7);
  const day = `${jump.getFullYear()}-${String(jump.getMonth() + 1).padStart(2, '0')}-${String(jump.getDate()).padStart(2, '0')}`;
  await setValue('.planner-date-entry input', day);
  await click('.planner-date-entry button[type="submit"]');
  await waitUntil(
    () =>
      execute(
        'return document.querySelector(".planner-day-column").dataset.plannerDay === arguments[0]',
        day,
      ),
    'Typed date did not navigate the calendar',
  );
  await click('.planner-date-trigger');
  await waitUntil(
    () => execute('return !!document.querySelector(".planner-date-popup[data-expanded]")'),
    'Date shortcut did not reopen',
  );
  await setValue('.planner-date-entry input', anchorDay);
  await click('.planner-date-entry button[type="submit"]');
  await waitUntil(
    () =>
      execute(
        'return document.querySelector(".planner-day-column").dataset.plannerDay === arguments[0]',
        anchorDay,
      ),
    'Date shortcut did not restore the test week',
  );
  await type('input[type="search"][aria-label="Search tasks"]', 'native');
  await delay(350);
  await execute('window.__nativeSmokeBeforeReload=true; return true;');
  await request('POST', `/session/${session}/refresh`, {});
  await waitUntil(
    () =>
      execute(
        'return !window.__nativeSmokeBeforeReload && document.querySelector(".planner-task-query input")?.value === "native"',
      ),
    'Task search did not restore after reload',
  );
  assert.equal(
    await execute(
      'return document.querySelector(\'[role="combobox"][aria-label="Sort tasks"]\').textContent.trim()',
    ),
    'Title',
  );
  await click('.planner-task-search-clear');
  await writeFile(
    path.join(scratch, 'date-shortcut-bounds.json'),
    JSON.stringify(dateBounds, null, 2),
  );
  console.log('Native task search, title sort, date shortcut, and view-state reload passed');
}
async function verifyOverlapAndSuggestions(inbox, saved) {
  await click('.planner-new-event');
  await waitUntil(dialogVisible, 'New item did not open the composer');
  const day = await execute(
    'return document.querySelectorAll(".planner-day-column")[1].dataset.plannerDay',
  );
  await setValue('dialog input[type="datetime-local"]:first-of-type', `${day}T10:15`);
  // Date inputs live in separate labels, so address them by their actual order.
  await execute(
    'const fields=document.querySelectorAll("dialog input[type=datetime-local]"); fields[1].value=arguments[0]; fields[1].dispatchEvent(new Event("input",{bubbles:true})); return true;',
    `${day}T10:45`,
  );
  await waitUntil(
    () =>
      execute(
        'return document.querySelector(".planner-overlap-notice")?.textContent.includes("Native range task")',
      ),
    'Overlap warning did not identify the existing local block',
  );
  assert.match(
    await execute('return document.querySelector(".planner-overlap-notice").textContent'),
    /30.*overlap/,
  );
  await click('.planner-slot-toggle');
  await waitUntil(
    () => execute('return document.querySelectorAll(".planner-slot-options button").length > 0'),
    'Free-time suggestions did not appear',
  );
  await click('.planner-slot-options button:first-child');
  await waitUntil(
    () => execute('return !document.querySelector(".planner-overlap-notice")'),
    'Suggested time still overlaps the existing block',
  );
  await click('dialog button[aria-label="Close"]');
  await waitUntil(async () => !(await dialogVisible()), 'Suggested-time draft did not cancel');
  assert.equal(
    await readFile(inbox, 'utf8'),
    saved,
    'Choosing a suggested time must not save until confirmed',
  );
  console.log('Native overlap warning and non-writing free-time suggestions passed');
}
async function verifyNarrowDateShortcut() {
  await request('POST', `/session/${session}/window/rect`, { width: 900, height: 792 });
  await execute(
    `localStorage.setItem('layout-state', JSON.stringify({leftPanelOpen:true,leftPanelWidth:200,rightPanelOpen:true,rightPanelWidth:250,activeRightPanelViewId:'planner.panel'})); window.__nativeSmokeBeforeReload=true; return true;`,
  );
  await request('POST', `/session/${session}/refresh`, {});
  await waitUntil(
    () =>
      execute(
        'return !window.__nativeSmokeBeforeReload && document.querySelectorAll(".planner-day-column").length === 1',
      ),
    'Narrow native window did not switch to one day',
  );
  await click('.planner-compact-bar > button');
  await click('.planner-date-trigger');
  await waitUntil(
    () => execute('return !!document.querySelector(".planner-date-popup[data-expanded]")'),
    'Narrow date shortcut did not open',
  );
  await verifyNativePaint();
  const bounds = await execute(
    `const read=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};}; const p=document.querySelector('.planner-date-popup'); return {pane:read(document.querySelector('.planner-main')),popup:read(p),entry:read(p.querySelector('.planner-date-entry')),today:read(p.querySelector('.planner-date-today')),trigger:read(document.querySelector('.planner-date-trigger'))};`,
  );
  assert.ok(bounds.pane.width <= 451, 'Narrow test must use an actual 450px app pane');
  assert.ok(
    bounds.popup.left >= bounds.pane.left && bounds.popup.right <= bounds.pane.right,
    'Date popup must stay inside the Planner pane',
  );
  assert.ok(
    bounds.today.bottom <= bounds.popup.bottom && bounds.entry.bottom <= bounds.popup.bottom,
    'Direct date entry and Today must remain visible in the narrow pane',
  );
  await writeFile(path.join(scratch, 'narrow-date-bounds.json'), JSON.stringify(bounds, null, 2));
  await writeFile(
    path.join(scratch, 'planner-native-narrow.png'),
    Buffer.from(await request('GET', `/session/${session}/screenshot`), 'base64'),
  );
  await pressKey('Escape');
  await waitUntil(
    () => execute('return !document.querySelector(".planner-date-popup[data-expanded]")'),
    'Escape did not close the narrow date shortcut',
  );
  await request('POST', `/session/${session}/window/rect`, { width: 1280, height: 900 });
  await execute(
    `localStorage.setItem('layout-state', JSON.stringify({leftPanelOpen:false,rightPanelOpen:false})); window.__nativeSmokeBeforeReload=true; return true;`,
  );
  await request('POST', `/session/${session}/refresh`, {});
  await waitUntil(
    () =>
      execute(
        'return !window.__nativeSmokeBeforeReload && document.querySelectorAll(".planner-day-column").length === 7',
      ),
    'Wide week did not restore after narrow layout test',
  );
  console.log('Native 450px Planner pane preserves full date shortcut and Today button');
}
async function verifyResizeAndCompletion(inbox, moved) {
  await waitUntil(
    () =>
      execute(
        `const body=[...document.querySelectorAll('.planner-block-body')].find(e=>e.textContent.includes('Native range task')); const block=body?.parentElement; return !!block && !block.classList.contains('planner-block-dragging') && !document.querySelector('.planner-preview-saving,.planner-floating-settling');`,
      ),
    'Moved block did not settle before resize',
  );
  const handle = await execute(
    `const block=[...document.querySelectorAll('.planner-block-body')].find(e=>e.textContent.includes('Native range task')).parentElement; const r=block.querySelector('.planner-resize:not(.planner-resize-top)').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};`,
  );
  await pointer(handle, { x: handle.x, y: handle.y + 24 });
  await waitUntil(
    async () => (await readFile(inbox, 'utf8')) !== moved,
    'Native resize did not persist',
  );
  const resized = await readFile(inbox, 'utf8');
  const metadata = JSON.parse(resized.match(/<!-- kuku-task: (\{.*?\}) -->/)[1]);
  assert.equal(
    (Date.parse(metadata.scheduledEnd) - Date.parse(metadata.scheduledStart)) / 60000,
    90,
  );
  await click('.planner-undo-notice button:first-of-type');
  await waitUntil(
    async () => (await readFile(inbox, 'utf8')) === moved,
    'Undo did not restore the prior schedule exactly',
  );
  await click('.planner-filters button:nth-child(2)');
  await waitUntil(
    () =>
      execute(
        'return !!document.querySelector(\'.planner-list-scroll input[aria-label="Native range task"]\')',
      ),
    'Scheduled task did not appear in Upcoming',
  );
  await click('.planner-list-scroll input[aria-label="Native range task"]');
  const completed = await waitUntil(async () => {
    const text = await readFile(inbox, 'utf8');
    return text.includes('- [x] Native range task') && text;
  }, 'Task completion did not persist to Markdown');
  assert.ok(
    await execute(
      'return [...document.querySelectorAll(".planner-is-complete .planner-block-body")].some(e=>e.textContent.includes("Native range task"))',
    ),
    'Completion must retain the time block as history',
  );
  assert.equal(
    completed.replace('- [x]', '- [ ]'),
    moved,
    'Completion must preserve all scheduling metadata',
  );
  console.log('Native resize, exact schedule undo, and completion with retained time block passed');
  return completed;
}
async function verifyNativeAi() {
  const trace = [];
  const toolsReady = async () => {
    const tools = await nativeInvoke('plugin:kuku-ai|ai_list_tools');
    const planner = tools.filter((tool) => tool.name.startsWith('planner_'));
    return planner.length === 17 && planner;
  };
  const descriptors = await waitUntil(
    toolsReady,
    'Production Planner AI descriptors were not registered',
  );
  aiEvidence = {
    model: 'Deterministic test tool calls; no live model or account',
    descriptors,
    trace,
  };
  assert.ok(descriptors.every((tool) => tool.source === 'proxy'));
  assert.equal(descriptors.find((tool) => tool.name === 'planner_tasks_search').access, 'readOnly');
  assert.equal(
    descriptors.find((tool) => tool.name === 'planner_task_create').access,
    'proposesMutation',
  );
  const call = async (mode, toolName, args, errorCode) => {
    const result = await nativeInvoke('planner_smoke_ai_tool', { mode, toolName, arguments: args });
    let data;
    try {
      data = JSON.parse(result.output);
    } catch {
      data = { message: result.output };
    }
    trace.push({ mode, toolName, isError: result.isError, result: data });
    if (errorCode) {
      assert.equal(result.isError, true, `${mode} ${toolName} must reject this call`);
      if (errorCode !== 'mode') assert.equal(data.error?.code, errorCode);
    } else {
      assert.equal(result.isError, false, `${toolName}: ${result.output}`);
      assert.equal(data.ok, true);
    }
    return data;
  };
  const inbox = path.join(vault, 'Tasks/Inbox.md');
  const before = await readFile(inbox, 'utf8');
  const createArgs = { title: 'AI native smoke', request_id: 'native-ai-create-001' };
  await call('ask', 'planner_task_create', createArgs, 'mode');
  await call('inline', 'planner_task_create', createArgs, 'mode');
  assert.equal(await readFile(inbox, 'utf8'), before);
  const search = await call('ask', 'planner_tasks_search', {
    query: 'Native drag task',
    source: 'note',
    sort: 'title',
  });
  assert.equal(search.tasks.length, 1);
  assert.equal(
    (await call('ask', 'planner_task_read', { ref: search.tasks[0].ref })).item.title,
    'Native drag task',
  );
  const created = await call('agent', 'planner_task_create', createArgs);
  assert.equal(created.durableReceipt, true);
  let task = created.task;
  assert.equal(task.path, 'Tasks/Inbox.md');
  assert.match(await readFile(inbox, 'utf8'), /- \[ \] AI native smoke <!-- kuku-task:/);
  const replay = await call('agent', 'planner_task_create', createArgs);
  assert.equal(replay.replayed, true);
  assert.equal((await readFile(inbox, 'utf8')).split('AI native smoke').length - 1, 1);
  const oldRevision = task.revision;
  task = (
    await call('agent', 'planner_task_update', {
      ref: task.ref,
      revision: task.revision,
      patch: { title: 'AI native renamed' },
    })
  ).task;
  const renamed = await readFile(inbox, 'utf8');
  await call(
    'agent',
    'planner_task_complete',
    { ref: task.ref, revision: oldRevision, completed: true },
    'STALE_REFERENCE',
  );
  assert.equal(await readFile(inbox, 'utf8'), renamed);
  const start = new Date(`${anchorDay}T13:00:00`).toISOString();
  const end = new Date(`${anchorDay}T14:00:00`).toISOString();
  task = (
    await call('agent', 'planner_task_schedule', {
      ref: task.ref,
      revision: task.revision,
      start,
      end,
      calendar_ref: null,
    })
  ).task;
  assert.equal(task.start, start);
  assert.equal(task.end, end);
  task = (
    await call('agent', 'planner_task_update', {
      ref: task.ref,
      revision: task.revision,
      patch: { due_date: anchorDay },
    })
  ).task;
  assert.equal(task.start, start, 'Changing the deadline must not move the scheduled block');
  const scheduled = await readFile(inbox, 'utf8');
  const availability = await call('ask', 'planner_availability', {
    day: anchorDay,
    duration_minutes: 30,
    preferred_start: start,
  });
  assert.equal(availability.overlap.minutes, 30);
  assert.ok(availability.suggestions.length > 0);
  assert.equal(await readFile(inbox, 'utf8'), scheduled);
  task = (
    await call('agent', 'planner_task_complete', {
      ref: task.ref,
      revision: task.revision,
      completed: true,
    })
  ).task;
  assert.equal(task.completed, true);
  assert.equal(task.start, start);
  assert.match(await readFile(inbox, 'utf8'), /- \[x\] AI native renamed/);
  const completed = await readFile(inbox, 'utf8');
  await execute('window.__nativeSmokeBeforeReload=true; return true;');
  await request('POST', `/session/${session}/refresh`, {});
  await waitUntil(
    () =>
      execute('return !window.__nativeSmokeBeforeReload && !!document.querySelector(".planner")'),
    'Planner did not reload before AI receipt replay',
  );
  await waitUntil(toolsReady, 'AI tools did not register after reload');
  const restored = await call('agent', 'planner_task_create', createArgs);
  assert.equal(restored.replayed, true);
  assert.equal(restored.task.title, 'AI native renamed');
  assert.equal(restored.task.completed, true);
  assert.equal(
    await readFile(inbox, 'utf8'),
    completed,
    'Replaying a completed request after restart must not create or overwrite a task',
  );
  task = restored.task;
  task = (await call('agent', 'planner_task_unassign', { ref: task.ref, revision: task.revision }))
    .task;
  assert.equal(task.start, undefined);
  assert.equal(task.dueDate, anchorDay);
  assert.equal(task.completed, true);
  await call('agent', 'planner_task_delete', {
    ref: task.ref,
    revision: task.revision,
    delete_block: true,
  });
  const deleted = await readFile(inbox, 'utf8');
  assert.ok(!deleted.includes('AI native renamed'));
  assert.ok(
    deleted.includes(before.trim()),
    'AI task deletion must preserve the existing note task and metadata',
  );
  assert.equal(await readFile(path.join(vault, 'Native.md'), 'utf8'), nativeNote);
  await writeFile(path.join(scratch, 'native-ai.json'), JSON.stringify(aiEvidence, null, 2));
  console.log(
    'Native AI mode gates, registry/proxy dispatch, task CRUD, scheduling, availability, CAS, and persisted request replay passed',
  );
}
async function verifyLiveModel() {
  const descriptors = await waitUntil(async () => {
    const tools = await nativeInvoke('plugin:kuku-ai|ai_list_tools');
    return tools.filter((tool) => tool.name.startsWith('planner_')).length === 17 && tools;
  }, 'Production Planner tools are not ready for the live model');
  const access = new Map(descriptors.map((tool) => [tool.name, tool.access]));
  // The opt-in native command only returns these public fields. Never call
  // ai_get_config: the configured credential must remain in native memory.
  console.log('Waiting for macOS Keychain to configure the authorized live model…');
  await request('POST', `/session/${session}/timeouts`, { script: 120000 });
  let configured;
  try {
    configured = await nativeInvoke('planner_smoke_ai_use_configured_model', {}, 120000);
  } finally {
    await request('POST', `/session/${session}/timeouts`, { script: 20000 });
  }
  liveEvidence = {
    provider: configured.provider,
    model: configured.model,
    source: configured.source,
    liveNetwork: true,
    passed: false,
    turns: [],
  };
  const captureReady = await request('POST', `/session/${session}/execute/async`, {
    script: `const done=arguments[arguments.length-1];
      const capture={sessions:{},listeners:[]}; window.__plannerLiveCapture=capture;
      const names=['ai:stream-chunk','ai:tool-call-start','ai:tool-call-end','ai:done','ai:error','ai:pending-approval'];
      Promise.all(names.map(name=>window.__TAURI__.event.listen(name,event=>{
        const p=event.payload, turn=capture.sessions[p.sessionId]; if(!turn)return;
        if(name==='ai:stream-chunk'){turn.text=(turn.text+p.delta).slice(0,24000);return;}
        const item={event:name,sessionId:p.sessionId};
        if(name==='ai:tool-call-start')Object.assign(item,{callId:p.callId,toolName:p.toolName,toolId:p.toolId,arguments:p.arguments});
        if(name==='ai:tool-call-end')Object.assign(item,{callId:p.callId,toolName:p.toolName,toolId:p.toolId,isError:p.isError,output:p.output});
        if(name==='ai:done')Object.assign(item,{finishReason:p.finishReason,usage:p.usage});
        if(name==='ai:error'){
          item.category=/quota|429|rate.?limit/i.test(p.message)?'rate-limit':/401|403|api.?key|unauth/i.test(p.message)?'authorization':/404|not found|unsupported.*model/i.test(p.message)?'model-unavailable':'provider-error';
          // The native Gemini adapter redacts the configured key before events.
          item.message=String(p.message).replace(/([?&](?:key|api_key|apikey)=)[^&\\s"']+/gi,'$1[redacted]').replace(/AIza[0-9A-Za-z_-]{20,}/g,'[redacted]').slice(0,2000);
        }
        if(name==='ai:pending-approval')item.toolName=p.toolName;
        turn.events.push(item);
      }))).then(listeners=>{capture.listeners=listeners;done(true);},()=>done(false));`,
    args: [],
  });
  assert.equal(captureReady, true, 'Live model event capture did not initialize');
  const persist = () =>
    writeFile(path.join(scratch, 'native-live-model.json'), JSON.stringify(liveEvidence, null, 2));
  const runTurn = async (mode, prompt, existingSession) => {
    const sessionId =
      existingSession || (await nativeInvoke('plugin:kuku-ai|ai_new_session', { mode })).sessionId;
    liveSessions.add(sessionId);
    await execute(
      'window.__plannerLiveCapture.sessions[arguments[0]]={text:"",events:[]};return true;',
      sessionId,
    );
    const turn = { mode, sessionId, prompt, status: 'running', text: '', events: [] };
    liveEvidence.turns.push(turn);
    await persist();
    await nativeInvoke('plugin:kuku-ai|ai_send_message', {
      sessionId,
      mode,
      content: prompt,
      editorContext: {},
    });
    const started = Date.now();
    let lastProgress = started;
    let lastCount = 0;
    while (Date.now() - started < 180000) {
      const current = await execute(
        'return window.__plannerLiveCapture.sessions[arguments[0]];',
        sessionId,
      );
      turn.text = current.text;
      turn.events = current.events;
      const calls = current.events.filter((event) => event.event === 'ai:tool-call-end');
      if (calls.length !== lastCount || Date.now() - lastProgress > 20000) {
        console.log(
          `Live ${mode}: ${calls.length} tool calls completed (${Math.round((Date.now() - started) / 1000)}s)`,
        );
        lastCount = calls.length;
        lastProgress = Date.now();
        await persist();
      }
      const error = current.events.find((event) => event.event === 'ai:error');
      const approval = current.events.find((event) => event.event === 'ai:pending-approval');
      if (error || approval) {
        turn.status = error ? error.category : 'unexpected-approval';
        await persist();
        await nativeInvoke('plugin:kuku-ai|ai_cancel', { sessionId });
        throw new Error(`Live ${mode} turn failed: ${turn.status}`);
      }
      const done = current.events.find((event) => event.event === 'ai:done');
      if (done) {
        turn.status = done.finishReason;
        await persist();
        assert.equal(done.finishReason, 'stop', `Live ${mode} turn did not finish normally`);
        return turn;
      }
      await delay(400);
    }
    turn.status = 'timeout';
    await persist();
    await nativeInvoke('plugin:kuku-ai|ai_cancel', { sessionId });
    throw new Error(`Live ${mode} turn exceeded three minutes`);
  };
  const inbox = path.join(vault, 'Tasks/Inbox.md');
  const readInbox = async () => {
    try {
      return await readFile(inbox, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return '';
      throw error;
    }
  };
  const before = await readInbox();
  console.log(`Testing live configured model: ${configured.provider}/${configured.model}`);
  const ask = await runTurn(
    'ask',
    'Planner에서 "Native drag task"라는 할 일을 실제로 찾아서 원본 노트 경로와 완료 여부를 알려주세요. 조회만 하고 어떤 항목도 변경하지 마세요.',
  );
  const askCalls = ask.events.filter((event) => event.event === 'ai:tool-call-end');
  assert.ok(
    askCalls.some((event) => event.toolName === 'planner_tasks_search' && !event.isError),
    'The live model must actually search Planner tasks',
  );
  assert.ok(
    ask.events
      .filter((event) => event.event === 'ai:tool-call-start')
      .every((event) => access.get(event.toolName) === 'readOnly'),
    'Ask must use only read-only tools',
  );
  assert.equal(await readInbox(), before);
  if (liveModelOnly) await assert.rejects(readFile(inbox, 'utf8'), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(vault, 'Native.md'), 'utf8'), nativeNote);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const title = 'Live model planner task';
  const agent = await runTurn(
    'agent',
    `Planner에서 현재 할 일 목록을 확인한 뒤 Kuku Inbox에 "${title}" 할 일을 정확히 하나 추가하고, ${anchorDay} 오후 1시부터 2시까지 (${zone}) 작업 시간을 배정해 주세요. 외부 캘린더는 연결하지 않은 상태이므로 Kuku 로컬 시간 블록으로 저장하세요. 생성과 시간 배정을 지금 실행해 주세요. 마감일은 지정하지 말고 아직 완료 처리하지 마세요. 기존 할 일은 수정하지 마세요.`,
  );
  const agentCalls = agent.events.filter(
    (event) => event.event === 'ai:tool-call-end' && !event.isError,
  );
  for (const name of ['planner_tasks_search', 'planner_task_create', 'planner_task_schedule'])
    assert.ok(
      agentCalls.some((event) => event.toolName === name),
      `The live model did not successfully call ${name}`,
    );
  const scheduled = await readFile(inbox, 'utf8');
  const rows = scheduled.split('\n').filter((line) => line.includes(title));
  assert.equal(rows.length, 1, 'Live creation must produce exactly one task');
  assert.ok(rows[0].startsWith('- [ ] '));
  const metadata = JSON.parse(rows[0].match(/<!-- kuku-task: (\{.*?\}) -->/)[1]);
  assert.equal(metadata.scheduledStart, new Date(`${anchorDay}T13:00:00`).toISOString());
  assert.equal(metadata.scheduledEnd, new Date(`${anchorDay}T14:00:00`).toISOString());
  assert.equal(metadata.dueDate, undefined, 'Live scheduling must not invent a deadline');
  assert.ok(scheduled.includes(before.trim()));
  await waitUntil(
    () =>
      execute(
        'return [...document.querySelectorAll(".planner-block-body")].some(e=>e.textContent.includes(arguments[0]));',
        title,
      ),
    'Live-created task was not rendered in the native calendar',
  );
  const complete = await runTurn(
    'agent',
    `방금 생성한 "${title}" 할 일을 완료 처리해 주세요. 배정한 시간 블록은 기록으로 유지하고 기존 다른 할 일은 바꾸지 마세요.`,
    agent.sessionId,
  );
  assert.ok(
    complete.events.some(
      (event) =>
        event.event === 'ai:tool-call-end' &&
        event.toolName === 'planner_task_complete' &&
        !event.isError,
    ),
    'The live model did not complete the task through Planner',
  );
  const completed = await readFile(inbox, 'utf8');
  assert.equal(
    completed,
    scheduled.replace(`- [ ] ${title}`, `- [x] ${title}`),
    'Live completion must preserve schedule metadata and the rest of the note',
  );
  await waitUntil(
    () =>
      execute(
        'return [...document.querySelectorAll(".planner-is-complete .planner-block-body")].some(e=>e.textContent.includes(arguments[0]));',
        title,
      ),
    'The completed live-model time block must remain on the calendar',
  );
  assert.equal(await readFile(path.join(vault, 'Native.md'), 'utf8'), nativeNote);
  liveEvidence.passed = true;
  liveEvidence.task = { title, path: 'Tasks/Inbox.md', completed: true, ...metadata };
  await persist();
  await execute(
    'for(const stop of window.__plannerLiveCapture.listeners)stop();delete window.__plannerLiveCapture;return true;',
  );
  // Drop the in-memory credential before screenshots or general failure capture.
  await nativeInvoke('plugin:kuku-ai|ai_reset_state');
  liveSessions.clear();
  console.log(
    'Live model chose Planner tools and completed search → create → schedule → complete with real native persistence',
  );
}
async function verifyComposerCancellation() {
  // A click previews the default 30-minute range. Cancelling must not write a note.
  const point = await position(0, 10 * 60);
  await dispatchPointer('pointerdown', point, 1);
  await dispatchPointer('pointerup', point, 0);
  await waitUntil(dialogVisible, 'Click did not open the creation dialog');
  const initialTimes = await execute(
    'return [...document.querySelectorAll("dialog input[type=datetime-local]")].map(e=>e.value)',
  );
  assert.equal((Date.parse(initialTimes[1]) - Date.parse(initialTimes[0])) / 60000, 30);
  await type('dialog input[required]:not([type])', 'Native cancelled draft');
  await pointerClick('dialog [role="combobox"][aria-label="Calendar"]');
  await waitUntil(selectMenuVisible, 'The composer calendar menu did not open');
  assert.equal(
    await execute('return !!document.querySelector("dialog .planner-select-content")'),
    true,
  );
  await execute(
    'window.__plannerPaintFrames=0; requestAnimationFrame(()=>{window.__plannerPaintFrames++; requestAnimationFrame(()=>window.__plannerPaintFrames++);}); return true;',
  );
  const painted = await waitUntil(
    () => execute('return window.__plannerPaintFrames===2'),
    'Native frame barrier did not advance',
    5000,
  ).catch(() => false);
  await delay(180);
  const paint = await execute(
    `const read=selector=>{const e=document.querySelector(selector); const r=e.getBoundingClientRect(),s=getComputedStyle(e); return {x:r.x,y:r.y,width:r.width,height:r.height,display:s.display,visibility:s.visibility,opacity:s.opacity};}; return {frames:window.__plannerPaintFrames,visibility:document.visibilityState,focused:document.hasFocus(),viewport:{width:innerWidth,height:innerHeight},dialog:read('dialog[open]'),menu:read('dialog .planner-select-content[data-expanded]')};`,
  );
  await writeFile(path.join(scratch, 'native-controls-paint.json'), JSON.stringify(paint, null, 2));
  await writeFile(
    path.join(scratch, 'planner-native-select.png'),
    Buffer.from(await request('GET', `/session/${session}/screenshot`), 'base64'),
  );
  console.log('Native controls paint', paint);
  assert.ok(painted, 'Native frame barrier must advance before visual assertions');
  for (const layer of [paint.dialog, paint.menu]) {
    assert.notEqual(layer.display, 'none');
    assert.equal(layer.visibility, 'visible');
    assert.ok(Number(layer.opacity) > 0.99);
    assert.ok(
      layer.width > 0 &&
        layer.height > 0 &&
        layer.x >= 0 &&
        layer.y >= 0 &&
        layer.x + layer.width <= paint.viewport.width + 1 &&
        layer.y + layer.height <= paint.viewport.height + 1,
    );
  }
  await pressKey('Escape');
  await waitUntil(
    async () => !(await selectMenuVisible()),
    'First Escape did not close the calendar menu',
  );
  assert.equal(await dialogVisible(), true, 'First Escape must leave the composer open');
  assert.equal(
    await execute('return document.querySelector("dialog input[required]:not([type])").value'),
    'Native cancelled draft',
  );
  await pressKey('Escape');
  await waitUntil(async () => !(await dialogVisible()), 'Second Escape did not close the composer');
  assert.equal(await readFile(path.join(vault, 'Native.md'), 'utf8'), nativeNote);
  console.log('Blank-slot preview and two-stage menu/composer Escape cancellation passed');
}
async function smoke() {
  try {
    await freePort(5179); // Never attach to, stop, or reuse a user's existing server.
    const port = await freePort();
    driver = `http://127.0.0.1:${port}`;
    const cachedBinary = path.join(root, 'target/native-smoke/KukuPlannerSmoke');
    if (!process.argv.includes('--skip-build')) {
      console.log('Building optional native-smoke app…');
      await run('cargo', ['build', '-p', 'kuku-app', '--features', 'native-smoke'], {
        env: { ...process.env, TAURI_CONFIG: config },
      });
      await mkdir(path.dirname(cachedBinary), { recursive: true });
      await copyFile(path.join(root, 'target/debug/kuku-app'), cachedBinary);
    }
    const app = path.join(scratch, 'KukuPlannerSmoke.app');
    nativeApp = app;
    const contents = path.join(app, 'Contents');
    const binary = path.join(contents, 'MacOS/KukuPlannerSmoke');
    await mkdir(path.dirname(binary), { recursive: true });
    await writeFile(
      path.join(contents, 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>KukuPlannerSmoke</string>
<key>CFBundleIdentifier</key><string>mom.kuku.app.native-smoke</string>
<key>CFBundleName</key><string>KukuPlannerSmoke</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>`,
    );
    // Ordinary development builds share target/debug/kuku-app. Never reuse that
    // path without the explicit feature build: it could be a user's normal app.
    await copyFile(cachedBinary, binary);
    // Freeze the current production UI for this run. Concurrent source edits must
    // not HMR-unmount the Planner midway through a native gesture assertion.
    const frontend = process.env.KUKU_SMOKE_FRONTEND || path.join(scratch, 'frontend');
    if (!process.env.KUKU_SMOKE_FRONTEND)
      await run(
        process.execPath,
        [path.join(desktop, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', frontend],
        { cwd: desktop },
      );
    launch(
      process.execPath,
      [
        path.join(desktop, 'node_modules/vite/bin/vite.js'),
        'preview',
        '--outDir',
        frontend,
        '--host',
        '127.0.0.1',
        '--port',
        '5179',
        '--strictPort',
      ],
      { cwd: desktop },
    );
    await waitUntil(async () => (await fetch('http://127.0.0.1:5179')).ok, 'Vite did not start');
    nativeExecutable = await realpath(binary);
    // LaunchServices opens a real application window through the supported macOS
    // launch command. No Accessibility, AppleScript, or synthetic native input.
    launch('/usr/bin/open', [
      '-n',
      '-W',
      '--stdout',
      nativeLog,
      '--stderr',
      nativeLog,
      '--env',
      'KUKU_NATIVE_SMOKE=1',
      '--env',
      `KUKU_NATIVE_SMOKE_ROOT=${data}`,
      '--env',
      `KUKU_SETTINGS_PATH=${path.join(data, 'settings.json')}`,
      '--env',
      `TAURI_WEBDRIVER_PORT=${port}`,
      ...(liveModel
        ? [
            '--env',
            'KUKU_NATIVE_SMOKE_LIVE_MODEL_SOURCE=kuku-dev',
            '--env',
            'RUST_LOG=off',
            '--env',
            'RUST_BACKTRACE=0',
          ]
        : []),
      app,
    ]);
    nativePid = await waitUntil(testProcessPid, 'The isolated native process did not start', 10000);
    await waitUntil(() => request('GET', '/status'), 'Native WebDriver did not start');
    const created = await request('POST', '/session', {
      capabilities: { alwaysMatch: { browserName: 'tauri' } },
    });
    session = created.sessionId;
    await waitUntil(
      () =>
        execute(
          'return location.href.startsWith("http://127.0.0.1:5179") && document.readyState === "complete"',
        ),
      'The native app document did not finish loading',
    );
    await verifyNativePaint();
    providerStatus = await Promise.all([
      nativeInvoke('planner_google_status'),
      nativeInvoke('planner_apple_status', { kind: 'calendar' }),
      nativeInvoke('planner_apple_status', { kind: 'reminders' }),
    ]);
    await writeFile(
      path.join(scratch, 'provider-status.json'),
      JSON.stringify(providerStatus, null, 2),
    );
    if (process.argv.includes('--probe-only')) {
      console.log(`PASS: isolated native launch and rendering. Evidence: ${scratch}`);
      return;
    }
    const agent = await execute('return navigator.userAgent');
    assert.match(agent, /AppleWebKit/);
    assert.doesNotMatch(agent, /Chrome/);
    // Select the real production Planner tab using the app's persisted tab format.
    await execute(
      `localStorage.setItem('tabs-state', JSON.stringify({tabs:[{fileName:'Planner',filePath:'',type:'planner',state:{planner:{anchor:arguments[0],filter:'unplanned',scrollTop:420}}}],activeFilePath:null,activeTabType:'planner'})); localStorage.setItem('layout-state', JSON.stringify({leftPanelOpen:false,rightPanelOpen:false})); window.__nativeSmokeBeforeReload = true; return true;`,
      anchorDay,
    );
    await request('POST', `/session/${session}/refresh`, {});
    await waitUntil(
      () =>
        execute(
          'return !window.__nativeSmokeBeforeReload && document.readyState === "complete" && document.querySelectorAll(".planner-day-column[data-planner-day]").length === 7',
        ),
      'Planner did not render',
    );
    console.log('Native WKWebView Planner loaded with isolated native vault IPC');
    await waitUntil(
      () =>
        execute(
          'return [...document.querySelectorAll(".planner-task-title")].some(e=>e.textContent === "Native drag task")',
        ),
      'The isolated native vault did not open',
    );
    if (liveModelOnly) {
      await verifyNativePaint();
      await verifyLiveModel();
      await writeFile(
        path.join(scratch, 'planner-native.png'),
        Buffer.from(await request('GET', `/session/${session}/screenshot`), 'base64'),
      );
      await writeFile(
        path.join(scratch, 'result.json'),
        JSON.stringify(
          {
            passed: true,
            mode: 'live-model-only',
            userAgent: agent,
            vault,
            providerStatus,
            liveModel: { provider: liveEvidence.provider, model: liveEvidence.model, passed: true },
            assertions: [
              'real native paint and isolated Planner vault load',
              'live Ask task search with no note changes',
              'live Agent creates one task and schedules the requested hour',
              'live Agent completion preserves deadline, schedule and original note',
            ],
          },
          null,
          2,
        ),
      );
      console.log(`PASS: native Planner live model smoke. Evidence: ${scratch}`);
      return;
    }

    // Select through the themed Kobalte menus inside the real native renderer.
    // Local-only settings still expose Inbox and the source filter choices.
    await pointerClick('[role="combobox"][aria-label="Task source"]');
    await waitUntil(selectMenuVisible, 'The custom task-source menu did not open');
    await pointerClick('.planner-select-content [role="option"]:nth-child(1)');
    await waitUntil(
      async () => !(await selectMenuVisible()),
      'Source selection did not close its menu',
    );
    assert.equal(
      await execute(
        'return document.querySelector(\'[role="combobox"][aria-label="Task source"]\').textContent.trim()',
      ),
      'Kuku Inbox',
    );
    await pointerClick('[role="combobox"][aria-label="Filter sources"]');
    await waitUntil(selectMenuVisible, 'The custom source-filter menu did not open');
    await pointerClick('.planner-select-content [role="option"]:nth-child(2)');
    await waitUntil(
      async () => !(await selectMenuVisible()),
      'Filter selection did not close its menu',
    );
    assert.equal(
      await execute(
        'return document.querySelector(\'[role="combobox"][aria-label="Filter sources"]\').title',
      ),
      'Filter sources: Kuku notes',
    );
    console.log('Custom native task-source and filter menu selections passed');
    await delay(160); // Let Kobalte's focus restoration and menu animation finish.
    await verifySearchAndDateJump();

    if (process.argv.includes('--controls-only')) {
      await verifyComposerCancellation();
      await writeFile(
        path.join(scratch, 'planner-native.png'),
        Buffer.from(await request('GET', `/session/${session}/screenshot`), 'base64'),
      );
      await writeFile(
        path.join(scratch, 'result.json'),
        JSON.stringify(
          {
            passed: true,
            mode: 'controls',
            userAgent: agent,
            vault,
            assertions: [
              'custom task-source and filter menus open and select local options',
              'blank click defaults to 30 minutes',
              'first Escape closes calendar menu and retains the composer draft',
              'second Escape closes composer without note writes',
            ],
          },
          null,
          2,
        ),
      );
      console.log(`PASS: native Planner controls smoke. Evidence: ${scratch}`);
      return;
    }

    // Lift an existing unplanned note task, shrink it on the calendar, and restore
    // its original card size outside the grid. Escape must cancel before any write.
    await click('.planner-filters button:nth-child(3)');
    await delay(160);
    const source = await waitUntil(
      () =>
        execute(`const row = [...document.querySelectorAll('[data-planner-drag-source]')].find(e=>e.textContent.includes('Native drag task'));
      if (!row) return null; const r = row.getBoundingClientRect(); return {x:r.left+r.width*0.4,y:r.top+r.height/2};`),
      'The seeded unplanned task did not appear',
    );
    const calendarTarget = await position(0, 10 * 60);
    const gutter = await execute(
      'const r=document.querySelector(".planner-hours").getBoundingClientRect(); return {x:r.left+r.width/2,y:arguments[0]};',
      calendarTarget.y,
    );
    const floatingCard = () =>
      execute(`const e=document.querySelector('.planner-floating-card'); if (!e) return null;
    const r=e.getBoundingClientRect(); return {width:r.width,height:r.height,overCalendar:e.dataset.overCalendar};`);
    await dispatchPointer('pointerdown', source, 1);
    await dispatchPointer('pointermove', gutter, 1);
    const lifted = await waitUntil(async () => {
      const card = await floatingCard();
      return card?.overCalendar === 'false' && card;
    }, 'The task card did not lift outside the calendar');
    await dispatchPointer('pointermove', calendarTarget, 1);
    await waitUntil(
      async () => (await floatingCard())?.overCalendar === 'true',
      'The card did not enter the calendar',
    );
    await delay(250); // Allow the production 180ms size/offset animation to settle.
    const inCalendar = await floatingCard();
    assert.ok(inCalendar.width < lifted.width - 1, 'Calendar hover must narrow the lifted card');
    assert.ok(inCalendar.height < lifted.height - 1, 'Calendar hover must shorten the lifted card');
    await writeFile(
      path.join(scratch, 'planner-native-hover.png'),
      Buffer.from(await request('GET', `/session/${session}/screenshot`), 'base64'),
    );
    await dispatchPointer('pointermove', gutter, 1);
    await waitUntil(
      async () => (await floatingCard())?.overCalendar === 'false',
      'The card did not leave the calendar',
    );
    await delay(250);
    const restored = await floatingCard();
    assert.ok(
      Math.abs(restored.width - lifted.width) < 1,
      'Leaving the calendar must restore card width',
    );
    assert.ok(
      Math.abs(restored.height - lifted.height) < 1,
      'Leaving the calendar must restore card height',
    );
    await execute(
      'window.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true,cancelable:true})); return true;',
    );
    await waitUntil(async () => !(await floatingCard()), 'Escape did not cancel the lifted card');
    await dispatchPointer('pointerup', gutter, 0);
    assert.equal(await readFile(path.join(vault, 'Native.md'), 'utf8'), nativeNote);
    await assert.rejects(readFile(path.join(vault, 'Tasks/Inbox.md'), 'utf8'), { code: 'ENOENT' });
    console.log(
      `Hover shrink/restore and Escape passed: ${lifted.width}x${lifted.height} → ${inCalendar.width}x${inCalendar.height} → ${restored.width}x${restored.height}`,
    );

    await verifyComposerCancellation();

    // Drag a 60-minute empty range, then create a real Markdown task in Inbox.
    await pointer(await position(1, 10 * 60), await position(1, 11 * 60));
    await waitUntil(dialogVisible, 'Range drag did not open the dialog');
    const times = await execute(
      'return [...document.querySelectorAll("dialog input[type=datetime-local]")].map(e=>e.value)',
    );
    assert.equal((Date.parse(times[1]) - Date.parse(times[0])) / 60000, 60);
    console.log('Pointer range selection passed');
    await click('dialog .planner-kind-picker button:nth-child(2)');
    await type('dialog input[required]:not([type])', 'Native range task');
    await click('dialog button[type="submit"]');
    await waitUntil(async () => !(await dialogVisible()), 'Native task creation failed');
    const inbox = path.join(vault, 'Tasks/Inbox.md');
    const saved = await waitUntil(async () => {
      const text = await readFile(inbox, 'utf8');
      return text.includes('Native range task') && text;
    }, 'Task did not persist through native vault IPC');
    assert.match(saved, /kuku-task:/);
    assert.match(saved, /scheduledStart/);
    console.log('Task persisted through native vault IPC');
    await verifyOverlapAndSuggestions(inbox, saved);

    // Move the new block with the same pointer implementation that handles list drops.
    const start = await execute(
      `const e = [...document.querySelectorAll('.planner-block-body')].find(e=>e.textContent.includes('Native range task')); const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+8};`,
    );
    const destination = await position(2, 10 * 60);
    await pointer(start, destination);
    await waitUntil(
      async () => (await readFile(inbox, 'utf8')) !== saved,
      'Native block drag did not persist',
    );
    let moved = await readFile(inbox, 'utf8');
    const movedMetadata = JSON.parse(moved.match(/<!-- kuku-task: (\{.*?\}) -->/)[1]);
    assert.equal(movedMetadata.plannedDate, destination.day);
    assert.equal(
      (Date.parse(movedMetadata.scheduledEnd) - Date.parse(movedMetadata.scheduledStart)) / 60000,
      60,
    );
    moved = await verifyResizeAndCompletion(inbox, moved);
    await execute('window.__nativeSmokeBeforeReload = true; return true;');
    await request('POST', `/session/${session}/refresh`, {});
    await waitUntil(
      () =>
        execute(
          'return !window.__nativeSmokeBeforeReload && document.readyState === "complete" && [...document.querySelectorAll(".planner-block-body")].some(e=>e.textContent.includes("Native range task"))',
        ),
      'Scheduled task did not restore after reload',
    );
    assert.equal(await readFile(inbox, 'utf8'), moved);
    await verifyNarrowDateShortcut();
    if (process.argv.includes('--ai')) await verifyNativeAi();
    if (liveModel) await verifyLiveModel();
    const screenshot = await request('GET', `/session/${session}/screenshot`);
    await writeFile(path.join(scratch, 'planner-native.png'), Buffer.from(screenshot, 'base64'));
    await writeFile(
      path.join(scratch, 'result.json'),
      JSON.stringify(
        {
          passed: true,
          userAgent: agent,
          vault,
          providerStatus,
          ai: aiEvidence ? 'passed' : 'not requested',
          liveModel: liveEvidence?.passed
            ? { provider: liveEvidence.provider, model: liveEvidence.model, passed: true }
            : 'not requested',
          hover: { lifted, inCalendar, restored },
          assertions: [
            'custom task-source and filter menus open and select local options',
            'unplanned card shrinks on calendar hover and restores outside',
            'Escape cancels lifted card without note writes',
            'blank click defaults to 30 minutes',
            'first Escape closes calendar menu and retains the composer draft',
            'second Escape closes composer without note writes',
            'cancel preserves notes',
            'pointer range selects 60 minutes',
            'native Inbox creation and metadata',
            'pointer block move persists',
            'resize persists, undo restores exact schedule, completion preserves the block',
            'reload restores time block',
            'task search and title sort with persisted view state',
            'date shortcut enters a date and remains inside the actual Planner pane',
            'overlap warning and free-time suggestions do not write until saved',
            '450px native pane preserves direct-date entry and Today',
          ],
        },
        null,
        2,
      ),
    );
    console.log(`PASS: native Planner smoke. Evidence: ${scratch}`);
  } catch (error) {
    if (liveEvidence)
      await writeFile(
        path.join(scratch, 'native-live-model.json'),
        JSON.stringify(liveEvidence, null, 2),
      );
    if (aiEvidence)
      await writeFile(path.join(scratch, 'native-ai.json'), JSON.stringify(aiEvidence, null, 2));
    await writeFile(
      path.join(scratch, 'result.json'),
      JSON.stringify({ passed: false, error: error.message, vault, providerStatus }, null, 2),
    );
    if (session) {
      try {
        await writeFile(
          path.join(scratch, 'failure-dom.html'),
          await execute('return document.documentElement.outerHTML'),
        );
      } catch {}
      try {
        await writeFile(
          path.join(scratch, 'failure.png'),
          Buffer.from(await request('GET', `/session/${session}/screenshot`), 'base64'),
        );
      } catch {}
    }
    console.error(`FAIL: ${error.stack}\nEvidence: ${scratch}`);
    process.exitCode = 1;
  } finally {
    if (liveModel && session) {
      for (const sessionId of liveSessions) {
        try {
          await nativeInvoke('plugin:kuku-ai|ai_cancel', { sessionId });
        } catch {}
      }
      try {
        await nativeInvoke('plugin:kuku-ai|ai_reset_state');
      } catch {}
    }
    if (session) {
      try {
        await request('DELETE', `/session/${session}`);
      } catch {}
    }
    if (nativeExecutable) {
      const currentPid = await testProcessPid();
      if (currentPid && (!nativePid || currentPid === nativePid))
        process.kill(currentPid, 'SIGTERM');
    }
    for (const child of children.reverse()) if (child.exitCode === null) child.kill('SIGTERM');
    await writeFile(path.join(scratch, 'native.log'), output.join(''));
  }
}
await smoke();
