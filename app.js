/* boots the kernel under qemu-wasm and wires the two uarts to the page.
   uart0 = console pane (qemu writes a file, polled here). uart1 = shell (stdio via xterm-pty). */

const QEMU_ARGS = [
  "-M", "virt",
  "-bios", "none",
  "-kernel", "/pack/kernel.elf",
  "-m", "8M",
  "-display", "none",
  "-monitor", "none",
  "-global", "virtio-mmio.force-legacy=false",
  "-drive", "file=/pack/kfs.raw,id=blk0,if=none,format=raw",
  "-device", "virtio-blk-device,drive=blk0",
  "-serial", "file:/pack/ser0.out",   // uart0 -> console pane
  "-serial", "stdio",                  // uart1 -> shell pane
  "-accel", "tcg,tb-size=500",
];

const $ = (sel) => document.querySelector(sel);
let consoleTerm, shellTerm, slavePty, qemuModule, ready = false;
let consoleAlive = false;
const MAX_BOOT_RETRIES = 3;

function setStatus(kind, text) {
  const dot = $("#statusdot");
  dot.className = "dot" + (kind ? " " + kind : "");
  $("#statustext").textContent = text;
}
function markStep(name, cls) {
  const el = document.querySelector(`.step[data-step="${name}"]`);
  if (el) el.className = "step " + cls;
}
function enableControls(on) {
  document.querySelectorAll(".toolbar .btn[data-cmd]").forEach(b => b.disabled = !on);
  $("#btn-reboot").disabled = !on;
}

function makeTerminals() {
  const common = {
    fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace',
    fontSize: 13, theme: { background: "#000000", foreground: "#cfe3ff" },
    cursorBlink: true, scrollback: 4000,
  };
  consoleTerm = new Terminal({ ...common, convertEol: true, disableStdin: true,
    theme: { background: "#000000", foreground: "#9ff5a9" } });
  shellTerm = new Terminal({ ...common });
  consoleTerm.open($("#term-console"));
  shellTerm.open($("#term-shell"));
  fit(consoleTerm, $("#term-console"));
  fit(shellTerm, $("#term-shell"));
  window.addEventListener("resize", () => {
    fit(consoleTerm, $("#term-console"));
    fit(shellTerm, $("#term-shell"));
  });
}
// use FitAddon if it loaded, else guess cols/rows from the element size
function fit(term, el) {
  try {
    if (window.FitAddon && window.FitAddon.FitAddon) {
      if (!term.__fit) { term.__fit = new FitAddon.FitAddon(); term.loadAddon(term.__fit); }
      term.__fit.fit();
      return;
    }
  } catch (e) { /* fall through */ }
  const cw = 8.0, ch = 17;
  const cols = Math.max(60, Math.floor((el.clientWidth - 16) / cw));
  const rows = Math.max(18, Math.floor((el.clientHeight - 10) / ch));
  term.resize(cols, rows);
}

// watch shell output for the prompt to know the shell is live
function tapShellOutput() {
  const orig = shellTerm.write.bind(shellTerm);
  let seen = "";
  shellTerm.write = (data, cb) => {
    try {
      const s = typeof data === "string" ? data : new TextDecoder().decode(data);
      seen = (seen + s).slice(-200);
      if (!ready && /IllinixOS>|Enter executable/.test(seen)) onShellReady();
    } catch (e) { /* ignore */ }
    return orig(data, cb);
  };
}
// no public input() on xterm.js, so fire the data event directly; xterm-pty forwards it to stdin
function sendToShell(data) {
  try {
    const core = shellTerm._core;
    if (core && core.coreService && core.coreService.triggerDataEvent) {
      core.coreService.triggerDataEvent(data, true);
      return;
    }
  } catch (e) { /* fall through */ }
  try { shellTerm.paste(data); } catch (e) { /* give up */ }
}

function onShellReady() {
  if (ready) return;
  ready = true;
  sessionStorage.removeItem("illinix-bootretry");
  markStep("shell", "done");
  // termio eats the first input byte after boot, so feed it a throwaway Enter
  setTimeout(() => sendToShell("\r"), 300);
  setStatus("ready", "shell ready");
  enableControls(true);
  shellTerm.focus();
}

// poll the console file qemu writes and stream new bytes into the left pane
function startConsolePump() {
  let pos = 0, sawOutput = false;
  const dec = new TextDecoder();
  setInterval(() => {
    if (!qemuModule || !qemuModule.FS) return;
    let buf;
    try { buf = qemuModule.FS.readFile("/pack/ser0.out"); } catch (e) { return; }
    if (buf.length > pos) {
      const chunk = buf.subarray(pos); pos = buf.length;
      consoleTerm.write(dec.decode(chunk));
      if (!sawOutput) {
        sawOutput = true;
        consoleAlive = true;
        sessionStorage.removeItem("illinix-bootretry");
        markStep("mmu", "done"); markStep("disk", "done"); markStep("shell", "active");
      }
    }
  }, 120);
}

// if nothing prints at all the wasm instance probably failed to start (happens
// now and then right after a reload), so reload a few times rather than sit on
// a dead shell. if the kernel is alive but the prompt text didn't match, just go.
function bootWatchdog() {
  setTimeout(() => { if (!ready && consoleAlive) onShellReady(); }, 6000);
  setTimeout(() => {
    if (ready || consoleAlive) return;
    const n = +(sessionStorage.getItem("illinix-bootretry") || 0);
    if (n < MAX_BOOT_RETRIES) {
      sessionStorage.setItem("illinix-bootretry", n + 1);
      sessionStorage.setItem("illinix-autostart", "1");
      setStatus("boot", `boot stalled, retrying ${n + 1}/${MAX_BOOT_RETRIES}`);
      location.reload();
    } else {
      sessionStorage.removeItem("illinix-bootretry");
      setStatus("err", "qemu failed to start, reload the page");
    }
  }, 12000);
}

async function boot() {
  setStatus("boot", "downloading WebAssembly…");
  makeTerminals();
  tapShellOutput();

  const { master, slave } = openpty();
  shellTerm.loadAddon(master);
  slavePty = slave;

  // grab the kernel + disk image, then drop them into the FS in preRun
  let kernelBuf, kfsBuf;
  try {
    [kernelBuf, kfsBuf] = await Promise.all([
      fetch("./kernel.elf").then(r => r.arrayBuffer()).then(b => new Uint8Array(b)),
      fetch("./kfs.raw").then(r => r.arrayBuffer()).then(b => new Uint8Array(b)),
    ]);
  } catch (e) {
    setStatus("err", "failed to download kernel image");
    return;
  }

  setStatus("boot", "starting RISC-V machine…");
  markStep("mmode", "active");

  const Module = {
    arguments: QEMU_ARGS,
    pty: slave,
    locateFile: (path) => new URL(path, location.href).href,
    mainScriptUrlOrBlob: new URL("out.js", location.href).href,
    preRun: [function () {
      const FS = Module.FS;
      try { FS.mkdir("/pack"); } catch (e) {}
      FS.writeFile("/pack/kernel.elf", kernelBuf);
      FS.writeFile("/pack/kfs.raw", kfsBuf);
      // console file has to exist before the poller and qemu both touch it
      try { FS.writeFile("/pack/ser0.out", new Uint8Array(0)); } catch (e) {}
    }],
    onRuntimeInitialized: function () {
      markStep("mmode", "done"); markStep("mmu", "active");
      setStatus("boot", "kernel booting…");
      startConsolePump();
      bootWatchdog();
    },
    onExit: function (code) {
      setStatus(code ? "err" : "", "halted (exit " + code + "), press reboot");
      enableControls(true);
    },
    print: () => {}, printErr: () => {},
  };
  qemuModule = Module;

  try {
    const factory = (await import("./out.js")).default;
    await factory(Module);
    // keep the tty poll responsive (from the qemu-wasm example)
    const oldPoll = Module.TTY && Module.TTY.stream_ops && Module.TTY.stream_ops.poll;
    if (oldPoll) {
      Module.TTY.stream_ops.poll = function (stream, timeout) {
        if (!slavePty.readable) return (slavePty.readable ? 1 : 0) | (slavePty.writable ? 4 : 0);
        return oldPoll.call(stream, timeout);
      };
    }
  } catch (e) {
    console.error(e);
    setStatus("err", "QEMU failed to start (see console)");
  }
}

document.querySelectorAll(".toolbar .btn[data-cmd]").forEach(btn => {
  btn.addEventListener("click", () => {
    const cmd = btn.getAttribute("data-cmd");
    shellTerm.focus();
    sendToShell(cmd + "\r");
  });
});
$("#btn-reboot").addEventListener("click", () => {
  sessionStorage.removeItem("illinix-bootretry");
  sessionStorage.setItem("illinix-autostart", "1");
  location.reload();
});

function launch() {
  $("#overlay").classList.add("hidden");
  boot();
}
$("#btn-launch").addEventListener("click", launch);
// re-launch after a reboot once isolation is back (can lag on static hosting)
if (sessionStorage.getItem("illinix-autostart") === "1") {
  sessionStorage.removeItem("illinix-autostart");
  let tries = 0;
  (function tryLaunch() {
    if (window.crossOriginIsolated) { launch(); return; }
    if (tries++ < 20) { setTimeout(tryLaunch, 150); return; }
    setStatus("err", "cross-origin isolation unavailable, reload the page");
  })();
}
