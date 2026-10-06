function base64Encode(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export function inboxPath(record) {
  const date = new Date(record.received_at);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `inbox/${year}/${month}/${record.id}.json`;
}

export async function storeMessage(env, record) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || "main";
  const token = env.GITHUB_TOKEN;
  if (!owner || !repo || !token) {
    throw new Error("missing GitHub storage config");
  }

  const path = inboxPath(record);
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "speaktoalex-worker",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({
      message: `Add SpeakToAlex message ${record.id}`,
      content: base64Encode(`${JSON.stringify(record, null, 2)}\n`),
      branch,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub storage failed ${response.status}: ${body.slice(0, 300)}`);
  }

  return { path, status: response.status };
}
