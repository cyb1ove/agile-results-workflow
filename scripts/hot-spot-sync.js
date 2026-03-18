// Load config from config.local.js (gitignored) or environment variables
let CONFIG = {
  GITHUB_OWNER: "cyb1ove",
  GITHUB_REPO: "obsidian",
  GITHUB_BRANCH: "master",
  TT_REDIRECT_URI: "http://localhost/callback",
}
if (typeof process !== "undefined" && process.env) {
  try {
    Object.assign(CONFIG, require("./config.local.js"));
  } catch (e) {}
  CONFIG = {
    ...CONFIG,
    ATL_USERNAME: process.env.ATL_USERNAME ?? CONFIG.ATL_USERNAME ?? "",
    ATL_PASSWORD: process.env.ATL_PASSWORD ?? CONFIG.ATL_PASSWORD ?? "",
    GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? CONFIG.GITHUB_TOKEN ?? "",
    TT_CLIENT_ID: process.env.TT_CLIENT_ID ?? CONFIG.TT_CLIENT_ID ?? "",
    TT_CLIENT_SECRET: process.env.TT_CLIENT_SECRET ?? CONFIG.TT_CLIENT_SECRET ?? "",
  }
}

const OBSIDIAN_PARA_FOLDERS = {
  INBOX: "1 - Inbox",
  PROJECTS: "2 - Projects",
  LIFE_AREAS: "3 - Life Areas",
  REFERENCES: "4 - References",
  ARCHIVE: "5 - Archive"
}

const HOT_SPOT_FOLDERS = {
  WORK: "Work Hot Spots",
  PERSONAL: "Personal Hot Spots",
  LIFE: "Life Hot Spots",
}

const HOT_SPOT_PREFIXES = {
  [HOT_SPOT_FOLDERS.WORK]: "@",
  [HOT_SPOT_FOLDERS.PERSONAL]: "#",
  [HOT_SPOT_FOLDERS.LIFE]: "+",
}

const ARCHIVE_HOT_SPOT_PREFIX = "(DEL) ";

// UTILITY FUNCTIONS

// Universal storage — works in Node.js and Scriptable
const isScriptable = typeof Keychain !== "undefined";

function storageSet(key, value) {
  if (isScriptable) {
    Keychain.set(key, value);
  } else {
    const fs = require("fs");
    let store = {};
    try { store = JSON.parse(fs.readFileSync(".storage.json", "utf8")); } catch(e) {}
    store[key] = value;
    fs.writeFileSync(".storage.json", JSON.stringify(store));
  }
}

function storageGet(key) {
  if (isScriptable) {
    return Keychain.contains(key) ? Keychain.get(key) : null;
  } else {
    const fs = require("fs");
    try {
      const store = JSON.parse(fs.readFileSync(".storage.json", "utf8"));
      return store[key] || null;
    } catch(e) { return null; }
  }
}

function storageRemove(key) {
  if (isScriptable) {
    if (Keychain.contains(key)) Keychain.remove(key);
  } else {
    const fs = require("fs");
    try {
      const store = JSON.parse(fs.readFileSync(".storage.json", "utf8"));
      delete store[key];
      fs.writeFileSync(".storage.json", JSON.stringify(store));
    } catch(e) {}
  }
}

async function httpRequest(url, method = "GET", headers = {}, body = null) {

  async function requestScriptable(url, method, headers, body) {
    const req = new Request(url);
    req.method = method;
    req.headers = headers;
    if (body) req.body = typeof body === "string" ? body : JSON.stringify(body);

    // Для DELETE и других запросов с пустым ответом — используем load() вместо loadJSON()
    const rawData = await req.load();
    const status = req.response?.statusCode || 200;
    const retryAfter = req.response?.headers?.["Retry-After"] || null;

    // Пробуем распарсить только если есть данные
    let json = null;
    if (rawData && rawData.length > 0) {
      try {
        json = JSON.parse(rawData.toRawString());
      } catch(e) {}
    }

    return {
      json,
      text: rawData ? rawData.toRawString() : null,
      status,
      ok: status >= 200 && status < 300,
      retryAfter
    };
  }

  async function requestNode(url, method, headers, body) {
    const options = {
      method,
      headers,
      body: body ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined
    };

    let response;
    try {
      response = await fetch(url, options);
    } catch(e) {
      throw new Error(`Сетевая ошибка: ${e.message}`);
    }

    const retryAfter = response.headers.get("Retry-After");
    const contentLength = response.headers.get("Content-Length");
    const contentType = response.headers.get("Content-Type") || "";

    let text = null;
    let json = null;

    // Читаем тело только если оно точно есть
    const hasBody =
      response.status !== 204 &&
      response.status !== 304 &&
      contentLength !== "0" &&
      method !== "HEAD";

    if (hasBody) {
      try {
        text = await response.text();
      } catch(e) {
        // Тело недоступно — не критично
        text = null;
      }

      if (text && contentType.includes("application/json")) {
        try { json = JSON.parse(text); } catch(e) {}
      } else if (text) {
        // Пробуем парсить даже без правильного Content-Type
        try { json = JSON.parse(text); } catch(e) {}
      }
    }

    return {
      json,
      text,
      status: response.status,
      ok: response.ok,
      retryAfter
    };
  }

  if (isScriptable) {
    return await requestScriptable(url, method, headers, body);
  } else {
    return await requestNode(url, method, headers, body);
  }
}

function b64(str) {
  if (isScriptable) {
    return Data.fromString(str).toBase64String();
  } else {
    return btoa(str);
  }
}

function sanitize(name) {
  return name
    .replace(/[\n\r\t]/g, " ")
    .replace(/\\/g, "")
    .replace(/["""'']/g, "")
    .replace(/[\x00-\x1F\x7F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 100)
}

// ATIMELOGGER FUNCTIONS

async function fetchATLTypes() {
  const url = "https://app.atimelogger.com/api/v2/types";

  const { json } = await httpRequest(url, "GET", {
    "Authorization": "Basic " + b64(`${CONFIG.ATL_USERNAME}:${CONFIG.ATL_PASSWORD}`),
    "Content-Type": "application/json"
  });

  if (!json || !json.types) {
    throw new Error("Failed to get types. Check ATimeLogger login/password.\n" + JSON.stringify(json));
  }
  
  return json.types; // array of objects with .name and .guid fields
}

function getHotSpotProjects(allTypes, parentFolders = Object.values(HOT_SPOT_FOLDERS)) {
  const byGuid = {};
  allTypes.forEach(type => { byGuid[type.guid] = type; });

  const childrenOf = {};
  allTypes.forEach(type => {
    if (type.parent && byGuid[type.parent]) {
      (childrenOf[type.parent] ??= []).push(type);
    }
  });

  const chains = [];
  function collectChains(node, path) {
    const currentPath = [...path, node.name];
    const children = childrenOf[node.guid];
    if (!children) {
      chains.push(currentPath);
    } else {
      children.forEach(child => collectChains(child, currentPath));
    }
  }

  const roots = allTypes.filter(t => !t.parent || !byGuid[t.parent]);
  roots.forEach(root => collectChains(root, []));

  const loggerToObsidianFolderAccordings = {
    [HOT_SPOT_FOLDERS.WORK]: OBSIDIAN_PARA_FOLDERS.PROJECTS,
    [HOT_SPOT_FOLDERS.PERSONAL]: OBSIDIAN_PARA_FOLDERS.PROJECTS,
    [HOT_SPOT_FOLDERS.LIFE]: OBSIDIAN_PARA_FOLDERS.LIFE_AREAS,
  };

  const projectNames = [];

  for (const parentFolder of parentFolders) {
    const matchingChains = chains.filter(chain => chain[0] === parentFolder);
    const prefix = HOT_SPOT_PREFIXES[parentFolder];

    const parentProjects = matchingChains.map(chain => ({
      name: prefix + chain.slice(1).map(sanitize).join(". "),
      path: loggerToObsidianFolderAccordings[parentFolder],
    }));

    projectNames.push(...parentProjects);
  }

  return projectNames;
}

// GITHUB FUNCTIONS

function githubHeaders() {
  return {
    "Authorization": `Bearer ${CONFIG.GITHUB_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json"
  };
}

async function folderExists(folderName) {
  const url = `https://api.github.com/repos/${CONFIG.GITHUB_OWNER}/${CONFIG.GITHUB_REPO}/contents/${encodeURIComponent(folderName)}/.gitkeep`;

  const { json } = await httpRequest(url, "GET", githubHeaders());

  return !!(json && json.sha); // файл существует
}

async function createFolder(folderName) {
  const path = `${encodeURIComponent(folderName)}/.gitkeep`;
  const url = `https://api.github.com/repos/${CONFIG.GITHUB_OWNER}/${CONFIG.GITHUB_REPO}/contents/${path}`;

  const { json } = await httpRequest(url, "PUT", githubHeaders(), JSON.stringify({
    message: `feat: add activity folder "${folderName}"`,
    content: b64(`# ${folderName}\n`),
    branch: CONFIG.GITHUB_BRANCH
  }));

  if (json && json.content && json.content.name) {
    return { ok: true };
  }
  return { ok: false, message: json.message || JSON.stringify(json) };
}

async function getAllHotSpotFoldersInObsidian() {
  const obsidianFoldersWithHotSpots = [OBSIDIAN_PARA_FOLDERS.PROJECTS, OBSIDIAN_PARA_FOLDERS.LIFE_AREAS];

  const hotSpotFolders = [];

  for (const folder of obsidianFoldersWithHotSpots) {
    const url = `https://api.github.com/repos/${CONFIG.GITHUB_OWNER}/${CONFIG.GITHUB_REPO}/contents/${encodeURIComponent(folder)}`;
    const req = await fetch(url, {
      method: "GET",
      headers: githubHeaders()
    });
    const json = await req.json();

    if (!Array.isArray(json)) return [];
    // Возвращаем только папки, исключая служебные
    hotSpotFolders.push(...json
      .filter(item => item.type === "dir")
      .filter(item => !item.name.startsWith("."))
    );
  }

  return hotSpotFolders;
}

/** Rename folder through Git Trees API — one commit, without copying files one by one */

async function prefixFolder(folderName, folderPath) {
  let newFolderName = folderName.replace(HOT_SPOT_PREFIXES[HOT_SPOT_FOLDERS.WORK], "");
  newFolderName = newFolderName.replace(HOT_SPOT_PREFIXES[HOT_SPOT_FOLDERS.PERSONAL], "");
  newFolderName = newFolderName.replace(HOT_SPOT_PREFIXES[HOT_SPOT_FOLDERS.LIFE], "");
  newFolderName = `${ARCHIVE_HOT_SPOT_PREFIX}${newFolderName}`;

  console.log(`\n✏️  Rename "${folderName}" → "${newFolderName}"...`);

  // 1. Получаем данные последнего коммита ветки
  const branchUrl = `https://api.github.com/repos/${CONFIG.GITHUB_OWNER}/${CONFIG.GITHUB_REPO}/branches/${CONFIG.GITHUB_BRANCH}`;
  const { json: branchJson } = await httpRequest(branchUrl, "GET", githubHeaders());

  const latestCommitSha = branchJson?.commit?.sha;
  const baseTreeSha = branchJson?.commit?.commit?.tree?.sha;

  if (!latestCommitSha || !baseTreeSha) {
    return { ok: false, error: "Failed to get SHA of commit/tree" };
  }

  // 2. Получаем полное дерево репозитория
  const treeUrl = `https://api.github.com/repos/${CONFIG.GITHUB_OWNER}/${CONFIG.GITHUB_REPO}/git/trees/${baseTreeSha}?recursive=1`;
  const { json: treeJson } = await httpRequest(treeUrl, "GET", githubHeaders());

  if (!treeJson?.tree) {
    return { ok: false, error: "Failed to get tree of repository" };
  }

  // Проверяем — если папка с префиксом уже существует, пропускаем
  const alreadyExists = treeJson.tree.some(
    item => item.path.startsWith(`${newFolderName}/`)
  );
  if (alreadyExists) {
    console.log("  ⏭ Already renamed");
    return { ok: true, skipped: true, fileCount: 0 };
  }

  // Файлы которые нужно переименовать
  const targetFiles = treeJson.tree.filter(
    item => item.type === "blob" && item.path.startsWith(`${folderPath}/`)
  );

  if (targetFiles.length === 0) {
    console.log("  ⚠ No files in folder");
    return { ok: true, skipped: true, fileCount: 0 };
  }

  console.log(`  📄 Files to rename: ${targetFiles.length}`);

  // 3. Формируем новое дерево:
  //    - для каждого файла старый путь удаляем (sha: null)
  //    - и добавляем тот же файл по новому пути (sha остаётся прежним — blob не меняется)
  const newTreeEntries = [];

  for (const file of targetFiles) {
    const newPath = file.path.replace(folderName, newFolderName);

    // Удалить старый путь
    newTreeEntries.push({
      path: file.path,
      mode: file.mode,
      type: "blob",
      sha: null  // null = удалить
    });

    // Создать по новому пути (переиспользуем тот же blob SHA — файл не перезаписывается)
    newTreeEntries.push({
      path: newPath,
      mode: file.mode,
      type: "blob",
      sha: file.sha
    });

    console.log(`  ➡ ${file.path} → ${newPath}`);
  }

  // 4. Создаём новое дерево на основе текущего
  const createTreeUrl = `https://api.github.com/repos/${CONFIG.GITHUB_OWNER}/${CONFIG.GITHUB_REPO}/git/trees`;
  const { json: newTree } = await httpRequest(
    createTreeUrl,
    "POST",
    githubHeaders(),
    JSON.stringify({
      base_tree: baseTreeSha,
      tree: newTreeEntries
    })
  );

  if (!newTree?.sha) {
    return { ok: false, error: "Failed to create new tree" };
  }

  // 5. Создаём новый коммит
  const createCommitUrl = `https://api.github.com/repos/${CONFIG.GITHUB_OWNER}/${CONFIG.GITHUB_REPO}/git/commits`;
  const { json: newCommit } = await httpRequest(
    createCommitUrl,
    "POST",
    githubHeaders(),
    JSON.stringify({
      message: `chore: rename "${folderName}" → "${newFolderName}"`,
      tree: newTree.sha,
      parents: [latestCommitSha]
    })
  );

  if (!newCommit?.sha) {
    return { ok: false, error: "Failed to create commit" };
  }

  // 6. Обновляем указатель ветки на новый коммит
  const updateRefUrl = `https://api.github.com/repos/${CONFIG.GITHUB_OWNER}/${CONFIG.GITHUB_REPO}/git/refs/heads/${CONFIG.GITHUB_BRANCH}`;
  const { json: refResult } = await httpRequest(
    updateRefUrl,
    "PATCH",
    githubHeaders(),
    JSON.stringify({ sha: newCommit.sha })
  );

  if (!refResult?.ref) {
    return { ok: false, error: "Tree and commit created, but branch not updated" };
  }

  return { ok: true, skipped: false, fileCount: targetFiles.length };
}

// TickTick OAuth2 FUNCTIONS

async function getTickTickToken() {
  const saved = storageGet("tt_access_token");
  if (saved) return saved;
  return await authorizeTickTick();
}

async function authorizeTickTick() {
  const authUrl =
    `https://ticktick.com/oauth/authorize` +
    `?client_id=${CONFIG.TT_CLIENT_ID}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(CONFIG.TT_REDIRECT_URI)}` +
    `&scope=tasks:read%20tasks:write`;

  let code = null;

  if (isScriptable) {
    // iOS: открываем WebView и перехватываем redirect
    const webview = new WebView();
    await webview.loadURL(authUrl);
    await webview.present(false);
    const currentUrl = await webview.evaluateJavaScript("window.location.href");
    const match = currentUrl.match(/[?&]code=([^&]+)/);
    if (!match) throw new Error("Failed to get authorization code.\nURL: " + currentUrl);
    code = match[1];
  } else {
    // Node.js: выводим ссылку и ждём ввода кода вручную
    console.log("\n🔐 TickTick authorization:");
    console.log("1. Open this link in browser:\n");
    console.log(authUrl);
    console.log("\n2. After authorization browser will redirect to localhost.");
    console.log("   Copy value of parameter ?code=... from address line.");
    console.log("3. Enter code below and press Enter:\n");

    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    code = await new Promise(resolve => rl.question("code: ", ans => { rl.close(); resolve(ans.trim()); }));
  }

  if (!code) throw new Error("Authorization code not entered");

  // Обмениваем code на access_token
  const { json: tokenJson } = await httpRequest(
    "https://ticktick.com/oauth/token",
    "POST",
    {
      "Authorization": "Basic " + b64(`${CONFIG.TT_CLIENT_ID}:${CONFIG.TT_CLIENT_SECRET}`),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(CONFIG.TT_REDIRECT_URI)}`
  );

  if (!tokenJson?.access_token) {
    throw new Error("Error getting token: " + JSON.stringify(tokenJson));
  }

  storageSet("tt_access_token", tokenJson.access_token);
  if (tokenJson.refresh_token) {
    storageSet("tt_refresh_token", tokenJson.refresh_token);
  }

  console.log("🔐 TickTick authorized");
  return tokenJson.access_token;
}

function clearTickTickToken() {
  storageRemove("tt_access_token");
  storageRemove("tt_refresh_token");
}

// TickTick API FUNCTIONS

function ttHeaders(token) {
  return { "Authorization": `Bearer ${token}` };
}

function ttJsonHeaders(token) {
  return { ...ttHeaders(token), "Content-Type": "application/json" };
}

async function fetchTickTickProjects(token) {
  const { json } = await httpRequest(
    "https://api.ticktick.com/open/v1/project",
    "GET",
    ttHeaders(token)
  );

  if (!Array.isArray(json)) {
    clearTickTickToken();
    throw new Error("Error getting projects (token reset, restart script)");
  }
  return json;
}

async function createTickTickProject(name, token) {
  const { json } = await httpRequest(
    "https://api.ticktick.com/open/v1/project",
    "POST",
    ttJsonHeaders(token),
    JSON.stringify({ name })
  );
  return json?.id ? json : null;
}


async function deleteTickTickProject(projectId, token) {
  const { ok, status } = await httpRequest(
    `https://api.ticktick.com/open/v1/project/${projectId}`,
    "DELETE",
    ttHeaders(token)
  );
  return ok;
}

// MAIN FUNCTION

async function main() {
  // 1. Get all hot spot folders in Obsidian

  let types;
  try {
    types = await fetchATLTypes();
  } catch (e) {
    // const err = new Alert();
    // err.title = "❌ Ошибка ATimeLogger";
    // err.message = e.message;
    // err.addAction("OK");
    // await err.presentAlert();
    // Script.complete();
    console.error("❌ Error ATimeLogger: " + e.message);
    return;
  }

  console.log(`📋 Found activity types: ${types.length}`);

  const hotSpotProjects = getHotSpotProjects(types);

  // 2. Create folders in Obsidian
  for (const hotSpotProject of hotSpotProjects) {
    if (!hotSpotProject.name) {
      console.log(`⚠️ Skip: folder name is empty: "${hotSpotProject.name}"`);
      continue;
    }

    const obsidianFolderPath = hotSpotProject.path + "/" + hotSpotProject.name;
    
    const isFolderExists = await folderExists(obsidianFolderPath);
    
    if (isFolderExists) {
      console.log(`⚠️ Skip: folder "${obsidianFolderPath}" already exists`);
    } else {
      const result = await createFolder(obsidianFolderPath);

      if (result.ok) {
        console.log(`✅ Folder "${obsidianFolderPath}" created`);
      } else {
        console.log(`❌ Error creating folder "${obsidianFolderPath}": ${result.message}`);
      }
    }
  }

  // 3. Find old folders in Github
  console.log("🔍 Find old folders in Github");
  const obsidianFolders = await getAllHotSpotFoldersInObsidian();

  const obsoleteHotSpotFolders = obsidianFolders.filter(folder => {
    return !hotSpotProjects.some(project => project.name === folder.name) && !folder.name.startsWith(ARCHIVE_HOT_SPOT_PREFIX);
  });
  console.log(`🔍 Found ${obsoleteHotSpotFolders.length} old folders`);

  // 4. Prefix old hot spot folders
  for (const folder of obsoleteHotSpotFolders) {
    const result = await prefixFolder(folder.name, folder.path);
    if (result.ok && !result.skipped) {
      console.log(`✅ Folder "${folder.name}" renamed to "${result.newFolderName}"`);
    } else if (result.ok && result.skipped) {
      console.log(`⏭ Folder "${folder.name}" already renamed`);
    } else {
      console.log(`❌ Error renaming folder "${folder.name}": ${result.error}`);
    }
  }

  // 4. Create TickTick lists
  console.log("\n📋 Synchronization TickTick...");
  console.log(`  🎯 Types for synchronization: ${hotSpotProjects.length}`);
  
  if (hotSpotProjects.length === 0) {
    console.log("  ⚠ No types for synchronization — skip");
  }

  let token;
  try {
    token = await getTickTickToken();
  } catch(e) {
    throw new Error("Error authorization TickTick: " + e.message);
  }

  let projects;
  try {
    projects = await fetchTickTickProjects(token);
  } catch(e) {
    throw new Error(e.message);
  }
  console.log(projects);
  console.log(`  📂 Projects in TickTick: ${projects.length}`);

  // Map of projects: name → object
  const projectMap = new Map(projects.map(p => [p.name, p]));

  // Create projects for new types
  for (const hotSpotProject of hotSpotProjects) {
    if (!hotSpotProject.name) continue;

    if (projectMap.has(hotSpotProject.name)) {
      console.log(`  ⏭ Already exists: "${hotSpotProject.name}"`);
    } else {
      console.log(`  ➕ Creating: "${hotSpotProject.name}"`);
      const created = await createTickTickProject(hotSpotProject.name, token);
      if (created) {
        projectMap.set(hotSpotProject.name, created);
        console.log(`    ✅ Created`);
      } else {
        console.log(`    ❌ Error creating`);
      }
    }
  }

  // Process projects without corresponding type
  for (const project of projects) {
    const name = project.name;

    // Protected lists — do not touch
    // if (name.startsWith("!")) {
    //   console.log(`  🔒 Защищён: "${name}"`);
    //   continue;
    // }

    // List is up to date — skip
    if (hotSpotProjects.some(project => project.name === name)) continue;

    // Type is missing in ATimeLogger — delete
    console.log(`  🗑 Deleting: "${name}"`);
    const deleted = await deleteTickTickProject(project.id, token);
    if (deleted) {
      console.log(`    ✅ Deleted`);
    } else {
      console.log(`    ❌ Error deleting`);
    }
  }
}

main().catch(async e => {
  console.error("Critical error: " + e.message);
  // const alert = new Alert();
  // alert.title = "Критическая ошибка";
  // alert.message = e.message;
  // alert.addAction("OK");
  // await alert.presentAlert();
  // Script.complete();
});