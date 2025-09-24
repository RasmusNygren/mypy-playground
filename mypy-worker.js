// mypy-worker.js (ESM)
import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v0.25.1/full/pyodide.mjs";
const PYODIDE_BASE = "https://cdn.jsdelivr.net/pyodide/v0.25.1/full/";

// Optional: if you host wheels locally, map them here.
// Example: const WHEEL_URL = { "1.10.0": "/wheels/mypy-1.10.0-py3-none-any.whl", ... };
const WHEEL_URL = {};

let pyodide = null;
let mypyImported = false;

function post(type, payload) { postMessage({ type, payload }); }

async function installMypy(version) {
  await pyodide.loadPackage("micropip");
  const url = WHEEL_URL[version];
  const py = `
import micropip
await micropip.install([${url ? JSON.stringify(url) : JSON.stringify(`mypy==${version}`)}])
# These are tiny and sometimes required by older mypy versions:
try:
  await micropip.install(["typing-extensions","mypy-extensions"])
except Exception:
  pass
`;
  await pyodide.runPythonAsync(py);
  // verify version
  let verProxy = await pyodide.runPythonAsync(`import importlib.metadata as md; md.version("mypy")`);
  const found = verProxy.toJs ? verProxy.toJs() : String(verProxy);
  verProxy.destroy?.();
  if (!found.startsWith(version)) {
    throw new Error(`Installed mypy ${found}, expected ${version}`);
  }
  mypyImported = false; // force fresh import
}

self.onmessage = async (e) => {
  const { type, payload } = e.data;
  try {
    if (type === "init") {
      pyodide = await loadPyodide({
        indexURL: PYODIDE_BASE,
        stdout: (s) => post("log", s),
        stderr: (s) => post("log", s),
      });

      await installMypy(payload?.mypyVersion || "1.10.0");

      const pythonVersion = pyodide.runPython(`import sys; sys.version.split()[0]`);
      const pyodideVersion = (pyodide.version || "0.25.1");
      let mv = await pyodide.runPythonAsync(`import importlib.metadata as md; md.version("mypy")`);
      const mypyVersion = mv.toJs ? mv.toJs() : String(mv);
      mv.destroy?.();

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
      let rproxy = await pyodide.runPythonAsync(`
from mypy import api
api.run(${JSON.stringify([`/app/${payload.filename}`])} + ${JSON.stringify(mypyFlags)})
      `);
      const result = rproxy.toJs();
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
