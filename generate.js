/**
 * 汽车配件销售日报 — 自动生成脚本
 * 运行: node generate.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

// ── 路径配置 ──────────────────────────────────────────────
const REPORTS_DIR  = path.join(__dirname, 'reports');
const INDEX_FILE   = path.join(__dirname, 'index.html');
const PROMPT_FILE  = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.claude', 'commands', 'car-daily.md'
);

// ── 初始化 ────────────────────────────────────────────────
fs.mkdirSync(REPORTS_DIR, { recursive: true });


if (!fs.existsSync(PROMPT_FILE)) {
  console.error(`❌ 找不到 Skill 文件: ${PROMPT_FILE}`);
  process.exit(1);
}

const prompt = fs.readFileSync(PROMPT_FILE, 'utf-8');

// ── 运行 Claude CLI（异步，避免 Windows stdin 死锁）────────
console.log('🚀 正在生成日报，预计需要 3~5 分钟...\n');

const childEnv = { ...process.env };
delete childEnv.CLAUDECODE;   // 允许嵌套运行

function runClaude(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      ['--print', '--output-format', 'text', '--allowedTools', 'WebSearch,WebFetch'],
      { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] }
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; process.stdout.write('.'); });
    child.stderr.on('data', d => { stderr += d; });

    child.on('close', code => {
      console.log('\n');
      if (code === 0) resolve(stdout);
      else reject(new Error(`claude 退出码 ${code}:\n${stderr}`));
    });
    child.on('error', err => reject(new Error(`无法启动 claude: ${err.message}`)));

    // 写入 prompt 后立即关闭 stdin，避免管道阻塞
    child.stdin.write(input, 'utf-8');
    child.stdin.end();

    // 15 分钟硬超时
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('超时：claude 运行超过 15 分钟'));
    }, 900_000);
    child.on('close', () => clearTimeout(timer));
  });
}

// ── 主流程（async 包裹，支持 await）──────────────────────
// --rebuild 模式：仅用现有模板重建所有 HTML，不调用 Claude
if (process.argv.includes('--rebuild')) {
  const reports = fs.readdirSync(REPORTS_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.html$/.test(f)).sort();
  for (const f of reports) {
    const dateId = f.replace('.html', '');
    const dateObj = new Date(dateId + 'T12:00:00');
    const dateDisplay = dateObj.toLocaleDateString('zh-CN', {
      year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
    });
    const raw = fs.readFileSync(path.join(REPORTS_DIR, f), 'utf-8');
    const bodyMatch = raw.match(/<article class="report-body">([\s\S]*?)<\/article>/);
    if (!bodyMatch) continue;
    const newHtml = buildReportPage(bodyMatch[1], dateDisplay, dateId);
    fs.writeFileSync(path.join(REPORTS_DIR, f), newHtml, 'utf-8');
    console.log(`✅ 已重建报告: ${f}`);
  }
  buildIndexPage();
  console.log(`✅ 首页已重建: ${INDEX_FILE}`);
  process.exit(0);
}

(async () => {
  let markdown;
  try {
    markdown = (await runClaude(prompt)).trim();
  } catch (err) {
    console.error('❌', err.message);
    process.exit(1);
  }
  if (!markdown) {
    console.error('❌ 生成内容为空，请检查网络连接和 API Key');
    process.exit(1);
  }

  // ── 过滤 Claude 的过程描述性文字 ──────────────────────────
  markdown = markdown
    .split('\n')
    .filter(line => {
      const t = line.trim();
      if (/^(全部|共|正在|已完成|搜索任务|整合数据|生成报告|数据整合|报告生成|以下是|根据以上|综合以上|基于以上|根据搜索|以下为您)/.test(t)) return false;
      if (/^(数据收集完毕|数据已收集|让我|开始搜索|已搜索|已完成搜索|以下是今日|以下是本期|以下报告|已完成所有)/.test(t)) return false;
      if (/个(搜索)?任务(均已|已全部|全部)/.test(t)) return false;
      if (/(搜索完成|任务完成|数据收集完成|正在整合|生成中|收集完毕|正在生成|整合完毕)/.test(t)) return false;
      return true;
    })
    .join('\n')
    .trim();

  // ── 解析日期 ────────────────────────────────────────────
  const today       = new Date();
  const dateId      = today.toISOString().split('T')[0];
  const dateDisplay = today.toLocaleDateString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
  });

  // ── Markdown → HTML ──────────────────────────────────────
  marked.use({ gfm: true, breaks: true });
  const bodyHtml = marked.parse(markdown);

  // ── 生成报告页 ──────────────────────────────────────────
  const reportHtml = buildReportPage(bodyHtml, dateDisplay, dateId);
  const reportFile = path.join(REPORTS_DIR, `${dateId}.html`);
  fs.writeFileSync(reportFile, reportHtml, 'utf-8');
  console.log(`✅ 日报已保存: ${reportFile}`);

  // ── 更新首页 ────────────────────────────────────────────
  buildIndexPage();
  console.log(`✅ 首页已更新: ${INDEX_FILE}`);
  console.log(`\n🌐 请用浏览器打开: ${INDEX_FILE}`);
})();

// ═══════════════════════════════════════════════════════════
//  报告内容后处理：注入 Hero Banner，去除过程文字
// ═══════════════════════════════════════════════════════════
function postProcessContent(html, dateId) {
  // 去除过程描述性段落
  html = html.replace(/<p>[^<]*(数据收集完毕|正在生成报告|收集完毕|正在整合)[^<]*<\/p>\s*/gi, '');
  // 去除孤立的 <hr>（标题前后）
  html = html.replace(/^\s*<hr\s*\/?>\s*/i, '');

  const carSvg = `<svg width="220" height="68" viewBox="0 0 220 68" xmlns="http://www.w3.org/2000/svg" style="opacity:0.28;display:block;margin:0 auto">
    <path d="M18,52 L18,42 L34,32 L62,22 L158,22 L186,32 L202,42 L202,52" fill="none" stroke="white" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <path d="M60,22 L72,10 L148,10 L160,22" fill="none" stroke="white" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="60" cy="54" r="11" fill="none" stroke="white" stroke-width="2"/>
    <circle cx="60" cy="54" r="4" fill="rgba(255,255,255,0.35)"/>
    <circle cx="158" cy="54" r="11" fill="none" stroke="white" stroke-width="2"/>
    <circle cx="158" cy="54" r="4" fill="rgba(255,255,255,0.35)"/>
    <path d="M20,52 L48,52 M72,52 L146,52 M170,52 L200,52" stroke="white" stroke-width="2" stroke-linecap="round"/>
    <line x1="0" y1="64" x2="220" y2="64" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
  </svg>`;

  const heroBanner = `<div class="report-title-hero">
  <div class="report-hero-car">${carSvg}</div>
  <div class="report-title-badge">📊 每日更新报告</div>
  <h1 class="report-main-title">汽车配件销售参考日报</h1>
  <div class="report-title-date">📅 ${dateId}</div>
  <div class="report-title-markets">
    <span>🇺🇸 美国</span><span>🇪🇺 欧洲</span><span>🌍 中东</span><span>🇲🇽 墨西哥</span><span>🇯🇵 日本</span><span>🇦🇺 澳新</span>
  </div>
</div>`;

  // 将报告标题 h3 替换为 hero banner
  html = html.replace(
    /<h3>📅\s*汽车配件销售参考日报[^<]*<\/h3>\s*(<hr\s*\/?>)?/i,
    heroBanner
  );

  return html.trim();
}

// ═══════════════════════════════════════════════════════════
//  生成单篇报告 HTML
// ═══════════════════════════════════════════════════════════
function buildReportPage(content, dateDisplay, dateId) {
  content = postProcessContent(content, dateId);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>全球汽车市场动态 · ${dateDisplay}</title>
  ${sharedStyles()}
</head>
<body>
  <header class="site-header">
    <div class="header-inner">
      <div class="header-brand">
        <span class="header-icon">🚗</span>
        <div>
          <h1>全球汽车市场动态</h1>
          <p class="header-sub">跨境电商选品 · 全球市场动态 · 每日更新</p>
        </div>
      </div>
      <div class="header-meta">
        <div class="date-badge">${dateDisplay}</div>
        <a href="../index.html" class="btn-back">← 返回归档</a>
      </div>
    </div>
  </header>

  <main class="main-wrap">
    <article class="report-body">
      ${content}
    </article>
  </main>

  <footer class="site-footer">
    <p>本报告由 Claude AI 自动生成 · 数据来源于公开信息 · 仅供参考</p>
    <p>生成时间: ${new Date().toLocaleString('zh-CN')}</p>
  </footer>

  ${reportScript()}
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════
//  生成首页（归档 + 最新报告预览）
// ═══════════════════════════════════════════════════════════
function buildIndexPage() {
  const reports = fs.readdirSync(REPORTS_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.html$/.test(f))
    .sort()
    .reverse();

  const latest = reports[0] || null;
  let latestContent = '<p class="no-report">暂无报告，请先运行生成脚本。</p>';
  let latestDateDisplay = '尚未生成';

  if (latest) {
    const raw = fs.readFileSync(path.join(REPORTS_DIR, latest), 'utf-8');
    const bodyMatch = raw.match(/<article class="report-body">([\s\S]*?)<\/article>/);
    const dateMatch = raw.match(/<div class="date-badge">([^<]+)<\/div>/);
    if (bodyMatch) latestContent = postProcessContent(bodyMatch[1], latest.replace('.html', ''));
    if (dateMatch) latestDateDisplay = dateMatch[1];
  }

  const archiveLinks = reports.map((f, i) => {
    const d = f.replace('.html', '');
    const label = i === 0 ? `${d} <span class="badge-new">最新</span>` : d;
    return `<li class="${i === 0 ? 'active' : ''}">
      <a href="reports/${f}">${label}</a>
    </li>`;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>全球汽车市场动态 · 归档</title>
  ${sharedStyles()}
  <style>
    /* Layout */
    .index-layout { display: grid; grid-template-columns: auto 1fr; gap: 28px; align-items: start; }

    /* Sidebar shell */
    .sidebar {
      background: #fff; border-radius: 12px; box-shadow: var(--shadow);
      position: sticky; top: 20px;
      width: 220px; overflow: hidden;
      transition: width 0.26s cubic-bezier(0.4,0,0.2,1);
      flex-shrink: 0;
    }
    .sidebar.is-collapsed { width: 40px; }

    /* Toggle button (shared) */
    .sidebar-btn {
      display: flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; border-radius: 50%;
      border: 1.5px solid #e2e8f0; background: #fff;
      cursor: pointer; font-size: 16px; color: #64748b;
      transition: all 0.2s; padding: 0; flex-shrink: 0; line-height: 1;
    }
    .sidebar-btn:hover { background: #f1f5f9; border-color: #94a3b8; color: #1e293b; }

    /* ── Expanded state ── */
    .sidebar-expanded-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 12px 8px;
    }
    .sidebar-head-title { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #888; font-weight: 600; white-space: nowrap; }
    .sidebar-list-wrap { padding: 4px 8px 12px; }
    .sidebar-list-wrap ul { list-style: none; margin: 0; padding: 0; }
    .sidebar-list-wrap li { border-radius: 6px; margin-bottom: 4px; }
    .sidebar-list-wrap li.active { background: var(--accent-bg); }
    .sidebar-list-wrap li.active a { color: var(--accent); font-weight: 600; }
    .sidebar-list-wrap a { display: block; padding: 7px 10px; font-size: 14px; color: #555; text-decoration: none; border-radius: 6px; }
    .sidebar-list-wrap a:hover { background: #f5f7fa; color: var(--accent); }

    /* ── Collapsed state ── */
    .sidebar-collapsed-face {
      display: none; flex-direction: column; align-items: center;
      gap: 10px; padding: 12px 0 16px; cursor: pointer;
    }
    .sidebar.is-collapsed .sidebar-collapsed-face { display: flex; }
    .sidebar.is-collapsed .sidebar-expanded-head,
    .sidebar.is-collapsed .sidebar-list-wrap { display: none; }
    .sidebar-v-text {
      writing-mode: vertical-rl; text-orientation: mixed;
      font-size: 12px; color: #64748b; font-weight: 600;
      letter-spacing: 0.14em; user-select: none;
    }

    .badge-new { background: #e74c3c; color: #fff; font-size: 11px; padding: 1px 5px; border-radius: 10px; margin-left: 4px; vertical-align: middle; }
    .no-report { color: #888; text-align: center; padding: 40px; }
    @media (max-width: 700px) {
      .index-layout { grid-template-columns: 1fr; }
      .sidebar { position: static; width: auto !important; }
      .sidebar.is-collapsed { width: auto !important; }
      .sidebar.is-collapsed .sidebar-collapsed-face { display: none; }
      .sidebar.is-collapsed .sidebar-expanded-head,
      .sidebar.is-collapsed .sidebar-list-wrap { display: flex !important; }
      .sidebar.is-collapsed .sidebar-list-wrap { display: block !important; }
    }
  </style>
</head>
<body>
  <header class="site-header">
    <div class="header-inner">
      <div class="header-brand">
        <span class="header-icon">🚗</span>
        <div>
          <h1>全球汽车市场动态</h1>
          <p class="header-sub">跨境电商选品 · 全球市场动态 · 每日更新</p>
        </div>
      </div>
      <div class="header-meta">
        <div class="date-badge">最新: ${latestDateDisplay}</div>
      </div>
    </div>
  </header>

  <main class="main-wrap">
    <div class="index-layout">
      <aside class="sidebar" id="sidebar">
        <!-- 收起状态 -->
        <div class="sidebar-collapsed-face" onclick="toggleSidebar()">
          <button class="sidebar-btn" aria-label="展开归档">☰</button>
          <span class="sidebar-v-text">历史归档</span>
        </div>
        <!-- 展开状态 -->
        <div class="sidebar-expanded-head">
          <span class="sidebar-head-title">📂 历史归档</span>
          <button class="sidebar-btn" onclick="toggleSidebar()" aria-label="收起归档">‹</button>
        </div>
        <div class="sidebar-list-wrap">
          <ul>${archiveLinks || '<li><a href="#">暂无记录</a></li>'}</ul>
        </div>
      </aside>

      <article class="report-body">
        ${latestContent}
      </article>
    </div>
  </main>

  <footer class="site-footer">
    <p>本报告由 Claude AI 自动生成 · 数据来源于公开信息 · 仅供参考</p>
    <p>共 ${reports.length} 份报告 · 最后更新: ${new Date().toLocaleString('zh-CN')}</p>
  </footer>

  ${reportScript()}
  <script>
    function toggleSidebar() {
      const sb = document.getElementById('sidebar');
      sb.classList.toggle('is-collapsed');
      localStorage.setItem('sbCollapsed', sb.classList.contains('is-collapsed') ? '1' : '0');
    }
    // 恢复上次状态
    if (localStorage.getItem('sbCollapsed') === '1') {
      document.getElementById('sidebar').classList.add('is-collapsed');
    }
  </script>
</body>
</html>`;

  fs.writeFileSync(INDEX_FILE, html, 'utf-8');
}

// ═══════════════════════════════════════════════════════════
//  共享 CSS
// ═══════════════════════════════════════════════════════════
function sharedStyles() {
  return `<style>
    :root {
      --accent: #2563eb;
      --accent-bg: #eff6ff;
      --header-from: #0f172a;
      --header-to: #1e3a5f;
      --shadow: 0 1px 4px rgba(0,0,0,.08), 0 4px 16px rgba(0,0,0,.06);
      --radius: 12px;
    }
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
           background: #f1f5f9; color: #1e293b; line-height: 1.7; font-size: 15px; }

    /* Header */
    .site-header { background: linear-gradient(135deg, var(--header-from), var(--header-to));
                   color: #fff; padding: 20px 0; }
    .header-inner { max-width: 1600px; margin: 0 auto; padding: 0 32px;
                    display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
    .header-brand { display: flex; align-items: center; gap: 14px; }
    .header-icon { font-size: 36px; }
    .header-brand h1 { margin: 0; font-size: 22px; font-weight: 700; }
    .header-sub { margin: 2px 0 0; font-size: 13px; opacity: .75; }
    .header-meta { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .date-badge { background: rgba(255,255,255,.15); border: 1px solid rgba(255,255,255,.25);
                  padding: 5px 14px; border-radius: 20px; font-size: 13px; }
    .btn-back { background: rgba(255,255,255,.15); border: 1px solid rgba(255,255,255,.25);
                color: #fff; text-decoration: none; padding: 5px 14px; border-radius: 20px;
                font-size: 13px; transition: background .2s; }
    .btn-back:hover { background: rgba(255,255,255,.25); }

    /* Layout */
    .main-wrap { max-width: 1600px; margin: 28px auto; padding: 0 32px 40px; }

    /* Report body */
    .report-body { background: #fff; border-radius: var(--radius); box-shadow: var(--shadow); padding: 36px 40px; }
    .report-body h1 { font-size: 22px; color: #0f172a; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px; margin-top: 0; }
    .report-body h2 { font-size: 18px; color: #1e3a5f; margin-top: 36px; padding: 8px 14px;
                      background: #f8fafc; border-left: 4px solid var(--accent); border-radius: 0 6px 6px 0; }
    .report-body h3 { font-size: 15px; color: #334155; margin-top: 24px; }
    .report-body h4 { font-size: 14px; color: #475569; margin-top: 18px; }
    .report-body p { margin: 10px 0; }
    .report-body a { color: var(--accent); }
    .report-body strong { color: #0f172a; }
    .report-body hr { border: none; border-top: 1px solid #e2e8f0; margin: 28px 0; }
    .report-body blockquote { margin: 12px 0; padding: 10px 16px; background: #f8fafc;
                               border-left: 3px solid #cbd5e1; border-radius: 0 6px 6px 0; color: #475569; }

    /* Tables */
    .report-body table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px; }
    .report-body th { background: #1e3a5f; color: #fff; padding: 10px 14px; text-align: left; font-weight: 600; }
    .report-body td { padding: 9px 14px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
    .report-body tr:hover td { background: #f8fafc; }
    .report-body tr:nth-child(even) td { background: #fafafa; }
    .report-body tr:nth-child(even):hover td { background: #f1f5f9; }

    /* Lists */
    .report-body ul, .report-body ol { padding-left: 22px; }
    .report-body li { margin: 5px 0; }

    /* Code */
    .report-body code { background: #f1f5f9; padding: 1px 5px; border-radius: 4px; font-size: 13px; }

    /* Footer */
    .site-footer { text-align: center; padding: 20px; font-size: 12px; color: #94a3b8; }

    /* Star ratings → colored */
    .report-body td:last-child, .report-body td { white-space: pre-line; }

    /* === Report Hero Banner === */
    .report-title-hero {
      text-align: center; padding: 48px 24px 40px;
      margin: -36px -40px 40px;
      background: linear-gradient(160deg, #0b1826 0%, #1a3c6e 50%, #0e2040 100%);
      border-radius: var(--radius) var(--radius) 0 0;
      position: relative; overflow: hidden; color: #fff;
    }
    .report-title-hero::before {
      content: ''; position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      background: radial-gradient(ellipse 80% 60% at 50% -10%, rgba(56,130,246,0.45) 0%, transparent 70%);
      pointer-events: none;
    }
    .report-title-hero::after {
      content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 1px;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.18), transparent);
    }
    .report-hero-car { position: relative; z-index: 1; margin-bottom: 6px; }
    .report-title-badge {
      position: relative; z-index: 1; display: inline-block;
      background: rgba(59,130,246,0.3); border: 1px solid rgba(59,130,246,0.6);
      color: #93c5fd; font-size: 11px; font-weight: 600;
      padding: 4px 14px; border-radius: 20px;
      letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 14px;
    }
    .report-main-title {
      position: relative; z-index: 1;
      font-size: 30px !important; font-weight: 800 !important; color: #fff !important;
      letter-spacing: -0.02em; margin: 0 0 10px !important;
      text-shadow: 0 2px 24px rgba(0,0,0,0.5);
      border: none !important; padding: 0 !important;
    }
    .report-title-date {
      position: relative; z-index: 1;
      font-size: 15px; color: rgba(255,255,255,0.72); margin-bottom: 20px;
    }
    .report-title-markets {
      position: relative; z-index: 1;
      display: flex; justify-content: center; flex-wrap: wrap; gap: 6px 10px;
      font-size: 12px; color: rgba(255,255,255,0.6);
    }
    .report-title-markets span {
      background: rgba(255,255,255,0.09); padding: 3px 10px; border-radius: 10px;
    }

    /* Enhanced section headers */
    .report-body h4 {
      font-size: 16px; color: #1a3869; margin-top: 36px;
      padding: 10px 18px; background: linear-gradient(90deg, #eff6ff, #f8fafc);
      border-left: 4px solid #2563eb; border-radius: 0 8px 8px 0;
      box-shadow: 0 1px 4px rgba(37,99,235,0.08);
    }

    @media (max-width: 700px) {
      .report-body { padding: 20px 16px; }
      .report-body table { font-size: 12px; }
      .report-body th, .report-body td { padding: 7px 9px; }
      .header-brand h1 { font-size: 17px; }
      .report-title-hero { padding: 32px 16px 28px; margin: -20px -16px 24px; }
      .report-main-title { font-size: 22px !important; }
    }
    @media print {
      .site-header { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .btn-back, .sidebar { display: none; }
    }
  </style>`;
}

// ═══════════════════════════════════════════════════════════
//  共享 JS（高亮星级评分）
// ═══════════════════════════════════════════════════════════
function reportScript() {
  return `<script>
    // 自动为表格单元格中的星级评分上色
    document.querySelectorAll('td').forEach(td => {
      if (td.textContent.includes('⭐⭐⭐')) td.style.color = '#16a34a';
      else if (td.textContent.includes('⭐⭐')) td.style.color = '#ca8a04';
      // 正负面标记
      if (td.textContent.startsWith('✅')) td.style.background = '#f0fdf4';
      if (td.textContent.startsWith('❌')) td.style.background = '#fef2f2';
      if (td.textContent.startsWith('➖')) td.style.background = '#fafafa';
    });
  </script>`;
}
