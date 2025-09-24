// mypy-worker.js (ESM)
import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v0.25.1/full/pyodide.mjs";
const PYODIDE_BASE = "https://cdn.jsdelivr.net/pyodide/v0.25.1/full/";

let pyodide = null;
let mypyImported = false;

function post(type, payload) { postMessage({ type, payload }); }

self.onmessage = async (e) => {
  const { type, payload } = e.data;
  try {
    if (type === "init") {
      pyodide = await loadPyodide({
        indexURL: PYODIDE_BASE,
        stdout: (s) => post("log", s),
        stderr: (s) => post("log", s),
      });

      await pyodide.loadPackage("micropip");
      await pyodide.runPythonAsync(`
    import micropip
    await micropip.install(["mypy==1.10.0", "typing-extensions", "mypy-extensions"])
      `);

      // Get versions as plain JS strings (no PyProxy leakage)
      const pythonVersion = pyodide.runPython(`import sys; sys.version.split()[0]`);
      const pyodideVersion = (pyodide.version || "Unknown"); // fallback if .version missing
      let mypyVerProxy = await pyodide.runPythonAsync(`import importlib.metadata as md; md.version("mypy")`);
      const mypyVersion = (mypyVerProxy.toJs ? mypyVerProxy.toJs() : mypyVerProxy);
      mypyVerProxy.destroy?.();

      post("init-done", { versions: {
        pyodide: String(pyodideVersion),
        python: String(pythonVersion),
        mypy: String(mypyVersion)
      }});
    }

    else if (type === "warmup") {
      await pyodide.runPythonAsync("from mypy import api");
      mypyImported = true;
      post("log", "mypy imported");
    }

    else if (type === "check") {
      if (!mypyImported) await pyodide.runPythonAsync("from mypy import api");
      post("checking");

      const { filename, code, mypyFlags } = payload;
      pyodide.FS.mkdirTree("/app");
      pyodide.FS.writeFile(`/app/${filename}`, code, { encoding: "utf8" });

      const start = performance.now();
      // ⬇️ Get (out, err, status) as plain JS
      let rproxy = await pyodide.runPythonAsync(`
from mypy import api
api.run(${JSON.stringify([`/app/${filename}`])} + ${JSON.stringify(mypyFlags)})
      `);
      const result = rproxy.toJs();       // ['out', 'err', status]
      rproxy.destroy?.();

      const out = result[0] || "";
      const err = result[1] || "";
      const status = result[2] ?? 0;

      const text = out + err;
      post("result", {
        diagnostics: parseMypy(text),
        text,
        status,
        durationMs: Math.round(performance.now() - start),
      });
    }
  } catch (err) {
    post("error", String(err));
  }
};

// same parseMypy as before…
function parseMypy(text) {
  const diags = [];
  const re = /^(.*?):(\d+):(?:(\d+):)?\s*(error|note|warning)?:?\s*(.*?)(?:\s+\[([a-z0-9\-]+)\])?$/gmi;
  let m;
  while ((m = re.exec(text)) != null) {
    diags.push({
      file: m[1] || "snippet.py",
      line: Number(m[2] || 1),
      column: m[3] ? Number(m[3]) : 1,
      severity: (m[4] || "error"),
      message: m[5] || "",
      code: m[6] || "",
    });
  }
  return diags;
}
