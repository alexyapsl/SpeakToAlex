import base64, json, os, sys, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_FILE = os.path.join(ROOT, "SpeakToAlexInbox.env")
OWNER, REPO, BRANCH = "alexyapsl", "SpeakToAlex-inbox", "main"
target = sys.argv[1]

with open(ENV_FILE, encoding="utf-8") as h:
    token = h.read().strip()

def gh(url):
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "speaktoalex-fetch",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

tree = gh(f"https://api.github.com/repos/{OWNER}/{REPO}/git/trees/{BRANCH}?recursive=1")
for entry in tree.get("tree", []):
    p = entry["path"]
    if p.startswith("inbox/") and p.endswith(".json") and target in p:
        obj = gh(f"https://api.github.com/repos/{OWNER}/{REPO}/contents/{p}")
        print(p)
        print(json.dumps(json.loads(base64.b64decode(obj["content"]).decode("utf-8")), indent=2, ensure_ascii=False))
        break
else:
    print("NOT FOUND", file=sys.stderr)
    sys.exit(1)
