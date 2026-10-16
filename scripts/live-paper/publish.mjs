// Publishes public experiment results only, on a separate branch. No chain writes.
const branch = "paper-reports";
export function createPublisher() {
  const token = process.env.PAPER_REPORT_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  let pending = Promise.resolve(),
    busy = false,
    last = 0;
  async function request(path, method = "GET", body) {
    const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 404 && method === "GET") return null;
    if (!response.ok) throw new Error(`Report publication HTTP ${response.status}`);
    return response.json();
  }
  async function publish(report) {
    if (!(await request(`git/ref/heads/${branch}`))) {
      await request("git/refs", "POST", {
        ref: `refs/heads/${branch}`,
        sha: process.env.GITHUB_SHA,
      });
    }
    const previous = await request(`contents/latest.json?ref=${branch}`);
    await request("contents/latest.json", "PUT", {
      message: `Paper test ${report.runId}: sample ${report.samples}`,
      branch,
      sha: previous?.sha,
      content: Buffer.from(JSON.stringify(report)).toString("base64"),
    });
  }
  return async (report, final = false) => {
    if (!token || !repo) return;
    if (final) await pending;
    if (!final && (busy || Date.now() - last < 60000)) return;
    last = Date.now();
    busy = true;
    // Snapshot now; do not let publication block 15-second market observations.
    const snapshot = structuredClone(report);
    pending = publish(snapshot)
      .catch((e) => console.error(e.message))
      .finally(() => {
        busy = false;
      });
    if (final) await pending;
  };
}
