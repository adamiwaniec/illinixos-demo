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
  // 64 MB translation buffer. plenty for the kernel + demos, and it has to fit the
  // fixed 512 MB wasm heap
  "-accel", "tcg,tb-size=64",
];

const $ = (sel) => document.querySelector(sel);
let consoleTerm, shellTerm, slavePty, qemuModule, ready = false;
let consoleAlive = false;
const MAX_BOOT_RETRIES = 3;
// pause before relaunching after a reboot. lets the old qemu worker die first;
// if the new one starts while it's still up they fight over threads and the new
// pty thread can fail to come up (dead shell).
const REBOOT_GRACE_MS = 800;
const DEBUG = false;  // set true to log the boot timeline to the devtools console
const dbg = (...a) => { if (DEBUG) console.log("[illinix]", ...a); };

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
    fontSize: 13,
    theme: { background: "#000000", foreground: "#cfe3ff",
             black: "#000000", brightBlack: "#3a3a3a" },
    cursorBlink: true, scrollback: 4000,
  };
  consoleTerm = new Terminal({ ...common, convertEol: true, disableStdin: true,
    theme: { background: "#000000", foreground: "#9ff5a9",
             black: "#000000", brightBlack: "#3a3a3a" } });
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
const TERM_COLS = 80, TERM_ROWS = 30;
const FONT_MAX = 15, FONT_MIN = 5;

function fit(term, el) {
  try {
    if (window.FitAddon && window.FitAddon.FitAddon) {
      if (!term.__fit) { term.__fit = new FitAddon.FitAddon(); term.loadAddon(term.__fit); }
      for (let fs = FONT_MAX; fs >= FONT_MIN; fs--) {
        term.options.fontSize = fs;
        term.__fit.fit();
        if ((term.cols >= TERM_COLS && term.rows >= TERM_ROWS) || fs === FONT_MIN)
          break;
      }
      return;
    }
  } catch (e) { /* fall through */ }
  const ratio = 0.60;                       // monospace advance / font-size
  const fs = Math.max(FONT_MIN,
                      Math.floor((el.clientWidth - 16) / (TERM_COLS * ratio)));
  term.options.fontSize = fs;
  term.resize(TERM_COLS, TERM_ROWS);
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
// feed data in as if typed (fires onData); xterm-pty forwards it to stdin
function sendToShell(data) {
  shellTerm.input(data, true);
}

function onShellReady() {
  if (ready) return;
  ready = true;
  dbg("shell ready (pty bridge live)");
  sessionStorage.removeItem("illinix-bootretry");
  markStep("shell", "done");
  // the first input burst after boot loses its leading byte to an rx overrun, so
  // prime the uart with a throwaway DEL. a DEL is a no-op at the start of an empty
  // line, so unlike a stray Enter it doesn't print a second prompt.
  setTimeout(() => sendToShell("\x7f"), 300);
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
        dbg("console (uart0) alive");
        // do NOT clear illinix-bootretry here. the console (uart0) comes up even
        // when the shell (uart1/pty) is dead, so clearing it on console output
        // would reset the counter every reload and recovery could never give up.
        // only a genuine shell-ready (onShellReady) clears it.
        markStep("mmu", "done"); markStep("disk", "done"); markStep("shell", "active");
      }
    }
  }, 120);
}

// stop the running qemu worker threads before navigating away, so the next
// instance doesn't start while this one is still tearing down (that contention
// is what leaves the pty/shell dead).
function killQemuThreads() {
  try { if (qemuModule && qemuModule.PThread) qemuModule.PThread.terminateAllThreads(); }
  catch (e) { dbg("terminateAllThreads failed (ok):", e && e.message); }
}

// reload a few times, then give up and show an error. the retry count lives in
// sessionStorage so it survives the reload; only a genuine shell-ready
// (onShellReady) clears it, never console output.
function recoverOrFail(reason) {
  if (ready) return;
  dbg("recover:", reason,
      "| consoleAlive=", consoleAlive,
      "| pty.readable=", slavePty && slavePty.readable,
      "| pty.writable=", slavePty && slavePty.writable);
  const n = +(sessionStorage.getItem("illinix-bootretry") || 0);
  if (n < MAX_BOOT_RETRIES) {
    sessionStorage.setItem("illinix-bootretry", n + 1);
    sessionStorage.setItem("illinix-autostart", "1");
    setStatus("boot", `${reason}, retrying ${n + 1}/${MAX_BOOT_RETRIES}`);
    killQemuThreads();
    location.reload();
  } else {
    sessionStorage.removeItem("illinix-bootretry");
    setStatus("err", `${reason} (gave up after ${MAX_BOOT_RETRIES}); reload to retry`);
    enableControls(false);
  }
}

// the kernel always brings up the shell on a fresh boot, so a dead shell after
// reload is a qemu-wasm/pty race, not a kernel bug. don't fake "ready": if the
// console is up but no prompt showed, poke the shell. a live one reprompts; if it
// stays silent the pty is dead, so reload and retry.
let probed = false;
function bootWatchdog() {
  setTimeout(() => {
    if (ready) return;
    if (!consoleAlive) { recoverOrFail("qemu did not start"); return; }
    if (!probed) { probed = true; sendToShell("\r"); }   // liveness probe
  }, 6000);
  setTimeout(() => recoverOrFail("shell did not come up"), 10000);
}

async function boot() {
  dbg("boot start");
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
      dbg("wasm runtime initialized, qemu starting");
      markStep("mmode", "done"); markStep("mmu", "active");
      setStatus("boot", "kernel booting…");
      startConsolePump();
      bootWatchdog();
    },
    onExit: function (code) {
      setStatus(code ? "err" : "", "halted (exit " + code + "), press reboot");
      enableControls(true);
    },
    // route qemu's own stdout/stderr to the devtools console, NOT the shell
    // terminal: the prompt-detection tap must only ever see real pty output, or
    // a fallback print could fake a "ready" shell that can't take input.
    print: (t) => dbg("qemu:", t),
    printErr: (t) => console.warn("[qemu]", t),
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
    // automatically enter trek once the program is running
    // until then we wait in the uart rx buffer
    if (btn.hasAttribute("data-enter"))
      setTimeout(() => sendToShell("\r"), 1000);
  });
});
$("#btn-reboot").addEventListener("click", () => {
  sessionStorage.removeItem("illinix-bootretry");
  // auto-reboot: relaunch through the graced autostart path (below) so the
  // launch overlay never shows and the old worker has time to be reclaimed.
  sessionStorage.setItem("illinix-autostart", "1");
  killQemuThreads();
  location.reload();
});

function launch() {
  $("#overlay").classList.add("hidden");
  boot();
}
$("#btn-launch").addEventListener("click", launch);
// auto-reboot path (reboot button / recovery set the flag): skip the launch
// overlay and boot after the grace delay. a fresh page load has no flag, so it
// still shows the overlay and waits for the button.
if (sessionStorage.getItem("illinix-autostart") === "1") {
  sessionStorage.removeItem("illinix-autostart");
  $("#overlay").classList.add("hidden");   // no launch screen on reboot
  setStatus("boot", "rebooting…");
  let tries = 0;
  (function waitThenBoot() {
    if (window.crossOriginIsolated) {
      dbg(`isolation ready, booting in ${REBOOT_GRACE_MS}ms`);
      setTimeout(boot, REBOOT_GRACE_MS);
      return;
    }
    if (tries++ < 20) { setTimeout(waitThenBoot, 150); return; }
    setStatus("err", "cross-origin isolation unavailable, reload the page");
  })();
}
