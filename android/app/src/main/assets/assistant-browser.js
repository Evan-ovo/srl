/* This file is the only external-page executor. No native bridge, cookie access or model code. */
(() => {
  const safe = text => String(text || '').replace(/([?&](?:code|token|access_token|refresh_token|id_token|password|secret|client_secret|api_key)=)[^&#\s]+/gi, '$1[已遮蔽]').replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}|(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{20,}/g, '[已遮蔽]').slice(0, 140);
  const rendered = el => !el.closest('[hidden],[aria-hidden="true"]') && [...el.getClientRects()].some(rect => rect.width > 0 && rect.height > 0) && getComputedStyle(el).visibility !== 'hidden';
  const visible = el => rendered(el) && [...el.getClientRects()].some(rect => rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth);
  const secret = el => /password|token|secret|credential|验证码|密码|密钥|令牌/i.test([el.type, el.name, el.id, el.autocomplete, el.getAttribute('title'), el.getAttribute('aria-label'), el.labels && [...el.labels].map(x => x.textContent).join(' ')].join(' '));
  const repositoryAuthorization = () => location.hostname === 'github.com' && /^\/(?:apps\/[^/]+\/installations|settings\/installations|organizations\/[^/]+\/settings\/installations)(?:\/|$)/.test(location.pathname);
  const connectionConsent = () => location.hostname === 'github.com' && /^\/login\/oauth\/authorize\/?$/.test(location.pathname);
  const login = () => /\/(login|signin|sign-in|sessions|oauth|authorize|register)(\/|$)/i.test(location.pathname) && !repositoryAuthorization() && !connectionConsent() || [...document.querySelectorAll('input[type="password"]')].some(visible);
  const disabled = el => el.disabled || el.closest('[aria-disabled="true"]');
  const label = el => safe(el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent || '').join(' ') || (el.labels && [...el.labels].map(x => x.textContent).join(' ')) || el.getAttribute('title') || el.getAttribute('placeholder') || (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) ? '' : el.textContent) || el.name || el.id);
  const result = (ok, extra = {}) => ({ ok, ...extra });
  const captionSelector = 'label,dt,legend,h1,h2,h3,h4,h5,h6';
  const captions = root => [...root.querySelectorAll(captionSelector)].filter(rendered);
  function repositoryAuthorizationError(el, payload) {
    if (!payload.autonomous || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(payload.expectedFork || '')) return '先核对本次自己的 Fork；不能猜授权仓库';
    const appPath = location.pathname.match(/^\/apps\/([^/]+)\/installations(?:\/|$)/);
    if (appPath && appPath[1] !== 'cloudflare-workers-and-pages') return '当前是另一 GitHub App，请定位本次 Cloudflare App，不为其它应用授权';
    const appIdentity = appPath?.[1] === 'cloudflare-workers-and-pages' || captions(document).some(node => /cloudflare\s+(?:workers(?:\s+(?:and|&)\s+pages)?|pages)\b/i.test(node.textContent)) || [...document.querySelectorAll('a[href]')].some(node => {
      if (!rendered(node)) return false;
      try { const url = new URL(node.href, location.href); return url.origin === location.origin && /^\/apps\/cloudflare-workers-and-pages\/?$/.test(url.pathname); }
      catch { return false; }
    });
    if (!appIdentity) return '未核对当前 GitHub App 是 Cloudflare，请观察实际应用名称';
    const root = el.closest('form,[role="dialog"]') || document;
    const selected = [...root.querySelectorAll('input[type="radio"],[role="radio"]')].filter(node => rendered(node) && (node.checked || node.getAttribute('aria-checked') === 'true'));
    if (!/\/installations\/new(?:\/|$)/.test(location.pathname) && selected.length === 1 && (selected[0].value === 'all' || /all repositories|全部仓库/i.test(label(selected[0])))) return '';
    if (!selected.some(node => node.value === 'selected' || /only select repositories|仅.*仓库|选定仓库/i.test(label(node)))) return '请先选择仅选定仓库，并核对本次 Fork；不要扩大到全部仓库';
    const repositories = [...root.querySelectorAll('select option:checked,[role="option"][aria-selected="true"],input[type="checkbox"]:checked,[role="checkbox"][aria-checked="true"]')].filter(node => rendered(node.tagName === 'OPTION' ? node.closest('select') : node)).map(node => label(node) || safe(node.textContent));
    for (const button of root.querySelectorAll('button[aria-label],button[title]')) {
      if (!rendered(button) || !/^(?:remove\b|移除)/i.test(label(button))) continue;
      const namedRepository = label(button).replace(/^(?:remove(?: repository)?|移除(?:仓库)?)\s*/i, '').trim();
      if (namedRepository) repositories.push(namedRepository);
      let scope = button.parentElement;
      for (let depth = 0; scope && depth < 3 && !scope.matches('form,main,body,html'); depth++, scope = scope.parentElement) {
        if (scope.textContent.length > 300) break;
        const name = scope.textContent.trim().replace(/remove(?: repository)?|移除仓库/gi, '').trim();
        if (name) { repositories.push(safe(name)); break; }
      }
    }
    const expected = payload.expectedFork.toLowerCase(), short = expected.split('/')[1];
    const names = repositories.map(name => name.trim().toLowerCase());
    if (!names.some(name => [expected, short].includes(name)) || /\/installations\/new(?:\/|$)/.test(location.pathname) && names.some(name => ![expected, short].includes(name))) return '尚未核对已选仓库包含本次 Fork；新安装只选本次仓库，已有安装保留其它仓库权限并添加本次仓库，不重复点授权';
    return '';
  }
  const publicParameterPage = () => location.hostname === 'discord.com' && /^\/developers\/applications\/\d{17,20}(?:\/|$)/.test(location.pathname) || location.hostname === 'dash.cloudflare.com' && /\/d1(?:\/|$)/.test(location.pathname);
  function d1DatabaseId(url) {
    try {
      const parsed = new URL(url, location.href);
      return parsed.origin === 'https://dash.cloudflare.com' && !parsed.username && !parsed.password ? parsed.pathname.match(/^\/[^/]+\/(?:workers\/)?d1\/databases\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:\/|$)/i)?.[1].toLowerCase() : undefined;
    } catch { return undefined; }
  }
  function fieldCaption(el) {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    if (el.labels?.length) return [...el.labels].map(item => item.textContent).join(' ');
    const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    if (ids.length) return ids.map(id => document.getElementById(id)?.textContent || '').join(' ');
    if (el.tagName === 'DD' && el.previousElementSibling?.tagName === 'DT') return el.previousElementSibling.textContent;
    let scope = el.parentElement;
    for (let depth = 0; scope && depth < 3; depth++, scope = scope.parentElement) {
      if (scope.matches('body,html,main,form,[role="main"]')) break;
      const names = [...new Set(captions(scope).map(item => item.textContent.trim()).filter(Boolean))];
      if (names.length === 1) return names[0];
      if (names.length > 1) break;
    }
    return el.getAttribute('placeholder') || el.name || el.id || '';
  }
  function fieldInfo(el) {
    const name = fieldCaption(el);
    return { label: safe(name), sensitive: secret(el) || /password|token|secret|credential|验证码|密码|密钥|令牌/i.test(name) };
  }
  function endpointFields(payload) {
    const fields = [...document.querySelectorAll('input')].filter(el => rendered(el) && ['text','url'].includes(el.type) && !el.disabled && !el.readOnly && !fieldInfo(el).sensitive);
    if (payload.target) return fields.filter(el => el.getAttribute('data-srl-discord-control') === payload.target && (fieldInfo(el).label || label(el)) === payload.label && !/application id|public key|应用.*id|公钥/i.test(fieldCaption(el)));
    return fields.filter(el => /^(interactions endpoint url|交互端点 url|交互端点网址)$/i.test(fieldCaption(el).trim()));
  }
  function pageKind() {
    const path = location.pathname;
    if (location.hostname === 'discord.com') return /^\/developers\/applications\/?$/.test(path) ? 'discord-app-list' : /\/information$/.test(path) ? 'discord-app-information' : /\/installation$/.test(path) ? 'discord-app-installation' : 'discord-other';
    if (location.hostname === 'dash.cloudflare.com') return /\/d1\//.test(path) ? 'd1-detail' : /\/workers\/services\/view\//.test(path) ? 'worker-detail' : 'cloudflare-overview';
    if (location.hostname.endsWith('.workers.dev')) return 'worker-site';
    if (location.hostname !== 'github.com') return 'webpage';
    return repositoryAuthorization() || connectionConsent() ? 'github-app-installation' : /\/edit\/.+\/wrangler\.jsonc?$/.test(path) ? 'wrangler-editor' : /\/blob\/.+\/wrangler\.jsonc?$/.test(path) ? 'wrangler-file' : /\/fork$/.test(path) ? 'github-fork' : 'github-repository';
  }
  function applicationList() {
    if (pageKind() !== 'discord-app-list') return undefined;
    const ids = new Set();
    for (const el of document.querySelectorAll('a[href]')) {
      if (!rendered(el)) continue;
      try {
        const url = new URL(el.getAttribute('href'), location.href);
        const match = /^\/developers\/applications\/(\d{17,20})(?:\/(?:information|installation|bot|oauth2))?\/?$/.exec(url.pathname);
        if (url.origin === location.origin && match) ids.add(match[1]);
      } catch (_) { /* Malformed links are not applications. */ }
    }
    const empty = [...document.querySelectorAll('p,span,div,h1,h2,h3,[role="status"]')].some(el => !el.childElementCount && visible(el) && !el.closest('form,[role="dialog"]') && el.textContent.length <= 180 && /^(?:no applications(?: yet)?|you (?:haven['’]t created any|don['’]t have any) applications(?: yet)?|create your first application|尚未创建(?:任何)?应用(?:程序)?|暂无应用(?:程序)?|没有应用(?:程序)?)[.!。！]?$/i.test(el.textContent.trim()));
    return { state: ids.size ? 'available' : empty ? 'empty' : 'unknown', count: ids.size };
  }
  function forkRelation() {
    if (location.hostname !== 'github.com') return false;
    return [...document.querySelectorAll('a[href]')].some(el => {
      if (!rendered(el)) return false;
      try {
        const url = new URL(el.getAttribute('href'), location.href);
        if (url.origin !== 'https://github.com' || url.username || url.password || !/^\/jixiangruyi117\/SRL-Discord-Bridge\/?$/.test(url.pathname)) return false;
        let scope = el.parentElement;
        for (let depth = 0; scope && depth < 3; depth++, scope = scope.parentElement) {
          if (scope.matches('body,html,main,article,form') || scope.querySelector('input,textarea') || scope.textContent.length > 500) break;
          if (/forked from|派生自|复刻自/i.test(scope.textContent)) return true;
        }
      } catch { /* An invalid link cannot establish repository identity. */ }
      return false;
    });
  }
  function repositoryIdentity() {
    if (location.hostname !== 'github.com') return null;
    const match = location.pathname.match(/^\/([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)(?:\/|$)/);
    if (!match) return null;
    const name = match[1];
    if (!forkRelation()) return null;
    const identity = { name, kind: 'fork' };
    const file = location.pathname.match(/\/(?:edit|blob)\/(.+)\/(wrangler\.jsonc?)$/);
    try { if (file) { identity.branch = decodeURIComponent(file[1]); identity.file = file[2]; } } catch { return null; }
    for (const node of document.querySelectorAll('script[type="application/json"][data-target="react-app.embeddedData"]')) {
      try {
        const layout = JSON.parse(node.textContent).payload?.codeViewLayoutRoute;
        if (layout?.repo?.ownerLogin + '/' + layout?.repo?.name === name && typeof layout.refInfo?.name === 'string') identity.branch = layout.refInfo.name;
      } catch { /* Unknown public schema is not identity evidence. */ }
    }
    return identity;
  }
  const secretLocation = () => location.hostname === 'dash.cloudflare.com' && /^\/[^/]+\/workers\/services\/view\/[^/]+(?:\/(?:production|settings)(?:\/.*)?)?$/.test(location.pathname);
  function secretValueCell(el) {
    const cell = el.closest('td,[role="cell"],[role="gridcell"]');
    if (!cell) return false;
    const row = cell.closest('tr,[role="row"]'), table = cell.closest('table,[role="table"],[role="grid"]');
    if (!row || !table) return true;
    const cells = [...row.querySelectorAll('td,[role="cell"],[role="gridcell"]')].filter(node => node.closest('tr,[role="row"]') === row);
    const headers = [...table.querySelectorAll('th,[role="columnheader"]')];
    const header = headers[cells.indexOf(cell)];
    if (!header) return !el.matches('button,[role="button"],a[href]') || !headers.some(node => /^(value|variable value|值|变量值)$/i.test(node.textContent.trim()));
    return /value|值/i.test(header.textContent);
  }
  function secretControlLabel(el) {
    // Never derive a control label from a variable's value cell or a whole form/table.
    if (secretValueCell(el) || el.querySelector('input,textarea,table,[role="table"]')) return '';
    if (['INPUT','TEXTAREA'].includes(el.tagName)) return safe(fieldCaption(el));
    return label(el);
  }
  function secretToggle(el) {
    if (!el || !(el.type === 'checkbox' || ['checkbox','switch'].includes(el.getAttribute('role')))) return false;
    const text = secretControlLabel(el).trim();
    return /\bsecret\b|\bencrypt(?:ed|ion)?\b|密钥|加密/i.test(text) && !/\b(?:not|disable|unencrypted|plaintext)\b|不加密|不要加密|明文|禁用/i.test(text);
  }
  function secretPublicTarget(el) {
    return !!el && !!secretControlLabel(el) && (!['INPUT','TEXTAREA'].includes(el.tagName) || secretToggle(el) || !fieldInfo(el).sensitive && !/value|值/i.test(fieldCaption(el))) && !secretValueCell(el) && !/show|reveal|copy|显示|展示|复制/i.test(secretControlLabel(el));
  }
  function secretSubmitButton(root, payload, names) {
    if (!payload.target) {
      const candidates = [...root.querySelectorAll('button,[role="button"],a[href]')].filter(el => visible(el) && !disabled(el) && /^(?:save(?:\s.*)?|deploy(?:\s.*)?|add\b.*\bdeploy|保存.*|部署.*|添加.*部署)$/i.test(label(el).trim()) && (payload.secretStage !== 'saved' || /deploy|部署/i.test(label(el))));
      return candidates.length === 1 ? candidates[0] : uniqueButton(root, names);
    }
    if (!/^\d{1,10}$/.test(payload.target)) return null;
    const nodes = document.querySelectorAll('[data-srl-discord-control="' + payload.target + '"]');
    const el = nodes.length === 1 ? nodes[0] : null;
    return el && visible(el) && !disabled(el) && el.matches('button,a[href],[role="button"]') && label(el) === payload.label && secretPublicTarget(el) && !/reset token|discard|delete|sign in|log in|登录|永久删除|重置令牌/i.test(payload.label) ? el : null;
  }
  function secretControls(payload) {
    const controls = [], query = String(payload.query || '').trim().toLowerCase();
    const botRows = new Set(existingSecretRows(document));
    if (query.length > 80 || safe(query) !== query || /[\x00-\x1f]/.test(query)) return result(false);
    let sequence = Number(payload.startSequence) || 0;
    for (const el of document.querySelectorAll('[data-srl-discord-control]')) el.removeAttribute('data-srl-discord-control');
    for (const el of document.querySelectorAll('a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="tab"],[role="menuitem"],[role="combobox"],[role="option"],[role="checkbox"],[role="switch"],[role="radio"]')) {
      if (!rendered(el)) continue;
      const text = secretControlLabel(el);
      if (!text || query && !query.split(/\s+/).every(term => text.toLowerCase().includes(term))) continue;
      const input = ['INPUT','TEXTAREA'].includes(el.tagName);
      const toggle = secretToggle(el);
      const valueField = input && !toggle && /value|值/i.test(fieldCaption(el));
      const target = String(++sequence); el.setAttribute('data-srl-discord-control', target);
      const section = el.closest('section,fieldset,[role="dialog"]');
      const heading = section?.querySelector('h1,h2,h3,h4,h5,h6,legend');
      const rowContext = botRows.has(el.closest('tr,[role="row"]')) ? 'DISCORD_BOT_TOKEN' : '';
      controls.push({ target, label: text, kind: valueField ? 'secret-value' : toggle ? el.getAttribute('role') || 'checkbox' : el.getAttribute('role') || el.tagName.toLowerCase(), sensitive: valueField || !toggle && input && fieldInfo(el).sensitive, ...(toggle ? { checked: el.type === 'checkbox' ? el.checked : el.getAttribute('aria-checked') === 'true' } : {}), visible: visible(el), ...(disabled(el) ? { disabled: true } : {}), ...(rowContext || heading ? { context: rowContext || safe(heading.textContent) } : {}) });
      if (el.tagName === 'SELECT') for (const option of el.options) {
        if (controls.length >= (query ? 25 : 100)) break;
        if (!option.disabled && option.textContent.trim()) { const id = String(++sequence); option.setAttribute('data-srl-discord-control', id); controls.push({ target: id, label: safe(option.textContent), kind: 'option', sensitive: false, checked: option.selected }); }
      }
      if (controls.length >= (query ? 25 : 100)) break;
    }
    for (const el of document.querySelectorAll('code,output,dd,span,div')) {
      if (controls.length >= (query ? 25 : 100)) break;
      if (!rendered(el) || el.childElementCount || el.closest('form,[role="dialog"],table,[role="table"],[role="grid"]') || secret(el) || fieldInfo(el).sensitive) continue;
      const text = el.textContent.trim();
      if (!/^(?:https:\/\/)?[a-z0-9.-]+\.workers\.dev\/?$/i.test(text) || query && !query.split(/\s+/).every(term => text.toLowerCase().includes(term))) continue;
      const target = String(++sequence); el.setAttribute('data-srl-discord-control', target);
      controls.push({ target, label: safe(text), kind: 'public-text', sensitive: false, visible: visible(el) });
    }
    const headings = captions(document).filter(el => !secretValueCell(el) && !el.querySelector('input,textarea,table')).slice(0, 12).map(el => safe(el.textContent));
    return result(true, { controls, headings, secretSavedOnPage: secretSavedOnPage(), pageKind: 'worker-detail', pageAccess: 'public', truncated: controls.length >= (query ? 25 : 100), ...(query ? { searchMatched: controls.length > 0 || headings.some(text => query.split(/\s+/).every(term => text.toLowerCase().includes(term))) } : {}) });
  }
  function namedFields(root, names, selector, eligible = visible) {
    return [...root.querySelectorAll(selector)].filter(el => eligible(el) && !disabled(el) && names.includes(label(el).trim().toLowerCase()));
  }
  function secretForm(payload = {}) {
    if (payload.secretMarker) {
      const bound = {};
      for (const key of ['root','name','type','valueElement']) {
        const nodes = document.querySelectorAll('[data-srl-secret-' + key + '="' + payload.secretMarker + '"]');
        if (nodes.length !== 1) break;
        bound[key] = nodes[0];
      }
      if (Object.keys(bound).length === 4 && ['name','type','valueElement'].every(key => bound.root.contains(bound[key]))) return bound;
    }
    if (payload.secretNameTarget || payload.secretTypeTarget || payload.secretValueTarget) {
      const selected = {};
      for (const [key, field] of [['name','secretNameTarget'],['type','secretTypeTarget'],['valueElement','secretValueTarget']]) {
        const observed = payload[field];
        if (!observed || !/^\d{1,10}$/.test(observed.target)) return null;
        const nodes = document.querySelectorAll('[data-srl-discord-control="' + observed.target + '"]');
        if (nodes.length !== 1 || !rendered(nodes[0]) || disabled(nodes[0]) || secretControlLabel(nodes[0]) !== observed.label) return null;
        selected[key] = nodes[0];
      }
      if (new Set(Object.values(selected)).size !== 3 || selected.name.tagName !== 'INPUT' || selected.name.type === 'password' || selected.name.readOnly || fieldInfo(selected.name).sensitive || /value|值/i.test(fieldCaption(selected.name)) || !['SELECT'].includes(selected.type.tagName) && selected.type.getAttribute('role') !== 'combobox' && !secretToggle(selected.type) || !['INPUT','TEXTAREA'].includes(selected.valueElement.tagName) || ['checkbox','radio'].includes(selected.valueElement.type) || selected.valueElement.readOnly) return null;
      let root = selected.name.parentElement;
      while (root && (!root.contains(selected.type) || !root.contains(selected.valueElement))) root = root.parentElement;
      // Bind the owning form/dialog, not only its field row: submit controls may be in its footer.
      root = root?.closest('form,[role="dialog"]') || root;
      return root && !root.matches('body,html,main,[role="main"]') ? { root, ...selected } : null;
    }
    const forms = [...document.querySelectorAll('form,[role="dialog"]')].map(root => ({
      root,
      names: namedFields(root, ['variable name','name','key','variable key','变量名称','变量名','名称','键','键名'], 'input:not([type="hidden"]):not([type="password"]):not([type="checkbox"]):not([type="radio"])'),
      types: [...root.querySelectorAll('select,[role="combobox"],input[type="checkbox"],[role="checkbox"],[role="switch"]')].filter(el => visible(el) && !disabled(el) && (secretToggle(el) || ['type','类型'].includes(label(el).trim().toLowerCase()))),
      // Only identify the value element from its label. Never access its value, text or validity.
      values: namedFields(root, ['value','variable value','值','变量值'], 'input:not([type="hidden"]),textarea'),
    })).filter(form => form.names.length === 1 && form.types.length === 1 && form.values.length === 1);
    const unique = forms.filter(form => !forms.some(other => other !== form && form.root.contains(other.root)));
    return unique.length === 1 ? { root: unique[0].root, name: unique[0].names[0], type: unique[0].types[0], valueElement: unique[0].values[0] } : null;
  }
  function secretType(form) {
    if (secretToggle(form.type)) return (form.type.type === 'checkbox' ? form.type.checked : form.type.getAttribute('aria-checked') === 'true') ? 'secret' : 'text';
    return (form.type.tagName === 'SELECT' ? form.type.selectedOptions[0]?.textContent : form.type.textContent || '').trim().toLowerCase();
  }
  function variableTable() {
    return [...document.querySelectorAll('table,[role="table"],[role="grid"]')].some(table => {
      const headers = [...table.querySelectorAll('th,[role="columnheader"]')].filter(rendered).map(el => el.textContent.trim());
      return headers.some(text => /^(name|key|variable name|名称|键|变量名|变量名称)$/i.test(text)) && headers.some(text => /^(value|variable value|值|变量值)$/i.test(text));
    });
  }
  function uniqueButton(root, names, eligible = visible) {
    const buttons = namedFields(root, names, 'button,[role="button"],a[href],[role="option"],[role="tab"],[role="menuitem"]', eligible);
    return buttons.length === 1 ? buttons[0] : null;
  }
  function existingSecretRows(root) {
    const matches = new Set();
    for (const table of root.querySelectorAll('table,[role="table"],[role="grid"]')) {
      const headers = [...table.querySelectorAll('th,[role="columnheader"]')];
      const names = headers.map((header, index) => rendered(header) && /^(name|key|variable name|名称|键|变量名|变量名称)$/i.test(header.textContent.trim()) ? index : -1).filter(index => index >= 0);
      if (names.length !== 1) continue;
      for (const row of table.querySelectorAll('tr,[role="row"]')) {
        const cells = [...row.querySelectorAll('td,[role="cell"],[role="gridcell"]')].filter(cell => cell.closest('tr,[role="row"]') === row);
        // Read only the column explicitly headed Name. Never inspect the value column or row text.
        const name = cells[names[0]];
        if (name && rendered(name) && name.textContent.trim() === 'DISCORD_BOT_TOKEN') matches.add(row);
      }
    }
    return [...matches];
  }
  function secretSavedOnPage() {
    // A visible editor is still pending. Read only the saved Name/Type columns, never Value or row text.
    if (secretForm() || [...document.querySelectorAll('form,[role="dialog"]')].some(root => rendered(root) && [...root.querySelectorAll('input:not([type="hidden"]),textarea')].some(rendered))) return false;
    const rows = existingSecretRows(document);
    if (rows.length !== 1) return false;
    const table = rows[0].closest('table,[role="table"],[role="grid"]');
    const headers = [...table.querySelectorAll('th,[role="columnheader"]')];
    const types = headers.map((header, index) => rendered(header) && /^(type|encryption|类型|加密类型)$/i.test(header.textContent.trim()) ? index : -1).filter(index => index >= 0);
    const cells = [...rows[0].querySelectorAll('td,[role="cell"],[role="gridcell"]')].filter(cell => cell.closest('tr,[role="row"]') === rows[0]);
    const type = types.length === 1 && cells[types[0]];
    if (!type || !rendered(type) || type.querySelector('input,textarea') || secretValueCell(type)) return false;
    return /\bsecret\b|\bencrypted\b|密钥|加密/i.test(type.textContent) && !/\btext\b|\bplain(?:text)?\b|明文|不加密/i.test(type.textContent);
  }
  function secretBindingError(form, marker) {
    if (!form) return '当前待提交 Secret 表单已关闭或未定位；先 inspect 核验列表结果，表单关闭不说明填写结果，不重复添加';
    if (form.name.value !== 'DISCORD_BOT_TOKEN') return '当前 Secret 名称不匹配，未提交；重新观察公开名称字段';
    if (!['secret','密钥'].includes(secretType(form))) return '当前 Secret 加密类型未确认，未提交；重新观察公开类型控件';
    if (Object.entries(form).some(([key, element]) => element.getAttribute('data-srl-secret-' + key) !== marker)) return 'Secret 表单绑定已变化，未提交；不能据此认定值未填写，先 inspect 核验当前表单或列表';
    return '';
  }
  function anchor(element) {
    element.scrollIntoView({ block: 'center', behavior: 'instant' });
    const rect = element.getBoundingClientRect();
    return { left: Math.max(0, rect.left / innerWidth), top: Math.max(0, rect.top / innerHeight), right: Math.min(1, rect.right / innerWidth), bottom: Math.min(1, rect.bottom / innerHeight) };
  }
  function highlight(elements) {
    for (const el of document.querySelectorAll('[data-srl-guidance-outline]')) { el.style.outline = el.getAttribute('data-srl-guidance-outline'); el.removeAttribute('data-srl-guidance-outline'); }
    for (const el of elements) { el.setAttribute('data-srl-guidance-outline', el.style.outline); el.style.outline = '2px solid #eab308'; }
  }
  function secretOperation(operation, payload) {
    if (!secretLocation() || payload.step !== 'cf-secret' || !/^[a-z0-9-]{1,60}$/.test(payload.secretMarker || '') || /\/(login|signin|oauth|authorize)(\/|$)/i.test(location.pathname)) return result(false);
    const form = secretForm(payload);
    if ((payload.secretNameTarget || payload.secretTypeTarget || payload.secretValueTarget) && !form) return result(false, { recovery: true, errors: ['指定表单字段已变化或不完整，请重新 inspect 公开标签，不重新添加 Secret'] });
    if (operation === 'fill-stored-secret') {
      if (payload.secretStage !== 'input') return result(false, { errors: ['当前不是本机秘密转填阶段'] });
      const bindingError = secretBindingError(form, payload.secretMarker);
      if (bindingError) return result(false, { recovery: true, errors: [bindingError] });
      if (typeof payload.secret !== 'string' || payload.secret.length > 512 || !/^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}$/.test(payload.secret)) return result(false);
      const proto = form.valueElement.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(form.valueElement, payload.secret);
      form.valueElement.dispatchEvent(new Event('input', { bubbles: true }));
      form.valueElement.dispatchEvent(new Event('change', { bubbles: true }));
      return result(true, { secretStage: 'submit' });
    }
    if ([...document.querySelectorAll('input[type="password"]')].some(el => visible(el) && el !== form?.valueElement)) return result(false, { waitingForUser: true, pageAccess: 'authentication' });
    if (operation === 'prepare-secret') {
      if (!['prepare','submit'].includes(payload.secretStage)) return result(false, { waitingForUser: true });
      if (payload.secretStage === 'submit' && !form) return result(false, { recovery: true, secretSavedOnPage: secretSavedOnPage(), errors: ['当前待提交表单已关闭；先核验列表和生产结果，不重新添加 Secret'] });
      if (form) {
        if (form.name.value && form.name.value !== 'DISCORD_BOT_TOKEN') return result(false);
        if (secretType(form) !== 'secret' && secretType(form) !== '密钥') {
          if (secretToggle(form.type)) {
            form.type.scrollIntoView({ block: 'center', behavior: 'instant' });
            form.type.click();
          } else if (form.type.tagName === 'SELECT') {
            const options = [...form.type.options].filter(option => /^(secret|密钥)$/i.test(option.textContent.trim()));
            if (options.length !== 1) return result(false);
            Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(form.type, options[0].value);
            form.type.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            const option = uniqueButton(document, ['secret','密钥']);
            (option || form.type).click();
          }
          return result(true, { dispatched: true, secretStage: 'prepare', preparedAction: 'type' });
        }
        if (form.name.value !== 'DISCORD_BOT_TOKEN') {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(form.name, 'DISCORD_BOT_TOKEN');
          form.name.dispatchEvent(new Event('input', { bubbles: true }));
          form.name.dispatchEvent(new Event('change', { bubbles: true }));
          if (form.name.value !== 'DISCORD_BOT_TOKEN') return result(false);
        }
        const current = secretForm(payload);
        if (!current || Object.keys(form).some(key => current[key] !== form[key])) return result(true, { dispatched: true, secretStage: 'prepare', preparedAction: 'name' });
        // Bind the handoff to these specific elements. A replaced form must be prepared again.
        for (const [key, element] of Object.entries(form)) element.setAttribute('data-srl-secret-' + key, payload.secretMarker);
        highlight([form.valueElement]);
        const guideAnchor = anchor(form.valueElement);
        return result(true, { secretStage: 'input', waitingForUser: true, guideAnchor, guideText: '名称和 Secret 类型已选好。只在这里填写 Bot Token，再点我“填好了，继续”。值不会读取或发送给模型。' });
      }
      const settings = uniqueButton(document, ['settings','设置'], rendered);
      if (settings && !/\/settings(?:\/|$)/.test(location.pathname) && settings.getAttribute('aria-selected') !== 'true') {
        if (settings.getAttribute('data-srl-secret-dispatched') === payload.secretMarker) return result(false, { waitingForUser: true });
        settings.setAttribute('data-srl-secret-dispatched', payload.secretMarker);
        settings.scrollIntoView({ block: 'center', behavior: 'instant' }); settings.click(); return result(true, { dispatched: true, secretStage: 'prepare', preparedAction: 'settings' });
      }
      const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(el => rendered(el) && /^(variables and secrets|变量和密钥|变量与密钥)$/i.test(el.textContent.trim()));
      if (headings.length !== 1) return result(false, { recovery: true });
      let scope = headings[0].parentElement;
      for (let depth = 0; scope && depth < 3; depth++, scope = scope.parentElement) {
        const existing = existingSecretRows(scope);
        if (existing.length) {
          const edit = existing.length === 1 && uniqueButton(existing[0], ['edit','edit variable','edit discord_bot_token','编辑','编辑变量'], rendered);
          if (!edit || edit.getAttribute('data-srl-secret-dispatched') === payload.secretMarker) return result(false, { waitingForUser: true });
          edit.setAttribute('data-srl-secret-dispatched', payload.secretMarker);
          edit.scrollIntoView({ block: 'center', behavior: 'instant' }); edit.click();
          return result(true, { dispatched: true, secretStage: 'prepare', preparedAction: 'edit' });
        }
        const add = uniqueButton(scope, ['add','添加'], rendered);
        if (add) {
          if (add.getAttribute('data-srl-secret-dispatched') === payload.secretMarker) return result(false, { waitingForUser: true });
          add.setAttribute('data-srl-secret-dispatched', payload.secretMarker);
          add.scrollIntoView({ block: 'center', behavior: 'instant' }); add.click(); return result(true, { dispatched: true, secretStage: 'prepare', preparedAction: 'add' });
        }
      }
      return result(false, { recovery: true });
    }
    if (!['submit','saved'].includes(payload.secretStage)) return result(false, { waitingForUser: true });
    if (payload.secretStage === 'submit') {
      const bindingError = secretBindingError(form, payload.secretMarker);
      if (bindingError) return result(false, { recovery: true, secretSavedOnPage: secretSavedOnPage(), errors: [bindingError] });
      const selected = secretSubmitButton(form.root, payload, ['deploy','save and deploy','save & deploy','部署','保存并部署']);
      const deploy = selected && /deploy|部署/i.test(label(selected)) ? selected : null;
      const save = selected || uniqueButton(form.root, ['save','save changes','保存','保存更改']);
      if (!save) return result(false, { recovery: true, errors: ['当前保存部署按钮未确认：可能不存在、禁用、多个候选或目标变化；inspect 实际公开按钮，不推断值未填写'] });
      for (const [key, element] of Object.entries(form)) element.removeAttribute('data-srl-secret-' + key);
      highlight([]);
      save.click();
      return result(true, { dispatched: true, secretStage: deploy ? 'submitted' : 'saved', waitingForUser: !!deploy });
    }
    // A separate deployment confirmation is supported only after this session dispatched Save.
    if (form && !payload.target) return result(false, { waitingForUser: true });
    const dialogs = [...document.querySelectorAll('[role="dialog"],form')].filter(visible);
    const deploy = (payload.target || dialogs.length === 1) && secretSubmitButton(dialogs[0] || document, payload, ['deploy','deploy changes','save and deploy','save & deploy','部署','保存并部署']);
    if (!deploy) return result(false, { recovery: true, errors: ['当前最终部署按钮未确认；inspect 当前浮层或已保存列表结果，不重复添加 Secret'] });
    deploy.click(); return result(true, { dispatched: true, secretStage: 'submitted', waitingForUser: true });
  }
  function editor() {
    const textareas = [...document.querySelectorAll('textarea[name="content"], textarea#code-editor, textarea[data-testid="code-editor"]')].filter(el => rendered(el) && !disabled(el) && !el.readOnly);
    const textarea = textareas.length === 1 ? textareas[0] : null;
    if (textarea) return { element: textarea, read: () => textarea.value, write: value => { const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(textarea, value); textarea.dispatchEvent(new Event('input', { bubbles: true })); textarea.dispatchEvent(new Event('change', { bubbles: true })); } };
    const cm = document.querySelector('.CodeMirror');
    if (cm && cm.CodeMirror) return { element: cm, read: () => cm.CodeMirror.getValue(), write: value => cm.CodeMirror.setValue(value) };
    const monaco = window.monaco && window.monaco.editor && window.monaco.editor.getModels();
    if (monaco && monaco.length === 1) return { element: document.querySelector('.monaco-editor'), read: () => monaco[0].getValue(), write: value => monaco[0].setValue(value) };
    const content = document.querySelector('.cm-content');
    // CodeMirror 6 DOM only contains the viewport. Its EditorView must supply the full document.
    const view = content && ((content.cmTile && content.cmTile.root && content.cmTile.root.view) || (content.cmView && content.cmView.view));
    if (view && view.state && view.dispatch) return { element: content, read: () => view.state.doc.toString(), write: value => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }) };
    return null;
  }
  function configuration(source) {
    let clean = '', quoted = false, escaped = false, comment = '';
    for (let i = 0; i < source.length; i++) {
      const char = source[i], next = source[i + 1];
      if (comment === 'line') { if (char === '\n') { comment = ''; clean += char; } continue; }
      if (comment === 'block') { if (char === '*' && next === '/') { comment = ''; i++; } continue; }
      if (quoted) { clean += char; if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
      if (char === '"') quoted = true;
      else if (char === '/' && (next === '/' || next === '*')) { comment = next === '/' ? 'line' : 'block'; i++; clean += ' '; continue; }
      clean += char;
    }
    if (comment === 'block') throw new Error('Unclosed comment');
    let json = ''; quoted = false; escaped = false;
    for (let i = 0; i < clean.length; i++) {
      const char = clean[i];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
      else if (char === '"') quoted = true;
      else if (char === ',' && /^\s*[}\]]/.test(clean.slice(i + 1))) continue;
      json += char;
    }
    return JSON.parse(json);
  }
  function validate(source) {
    const errors = [];
    if (typeof source !== 'string' || source.length > 100000) return result(false, { errors: ['未读到完整 Wrangler 编辑内容'] });
    let value;
    try { value = configuration(source); } catch { return result(false, { errors: ['配置必须是完整 JSON/JSONC，请检查注释、逗号、引号和括号'] }); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result(false, { errors: ['配置根节点必须是对象'] });
    // Validate executable requirements, not tutorial names or harmless extra bindings. Never echo values.
    if (typeof value.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/i.test(value.name) || typeof value.main !== 'string' || !/\.(?:[cm]?[jt]s)$/.test(value.main) || value.main.startsWith('/') || value.main.split('/').includes('..') || !/^\d{4}-\d{2}-\d{2}$/.test(value.compatibility_date || '') || !Number.isFinite(Date.parse(value.compatibility_date))) errors.push('Worker 名称、入口或兼容日期无效');
    const bindings = Array.isArray(value.d1_databases) ? value.d1_databases.filter(row => row?.binding === 'DB') : [];
    const db = bindings.length === 1 ? bindings[0] : null;
    if (!db || typeof db.database_name !== 'string' || !db.database_name.trim() || db.migrations_dir !== undefined && (typeof db.migrations_dir !== 'string' || !db.migrations_dir.trim() || db.migrations_dir.startsWith('/') || db.migrations_dir.split('/').includes('..'))) errors.push('D1 需要唯一 DB 绑定及有效名称、迁移目录');
    if (!db || typeof db.database_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(db.database_id)) errors.push('D1 Database ID 必须是 UUID，不能填名称或占位符');
    const vars = value.vars;
    const privateField = item => item && typeof item === 'object' && Object.entries(item).some(([key, content]) => /(?:^|_)(?:bot_token|access_token|refresh_token|client_secret|password|api_key|authorization|credential)(?:$|_)/i.test(key) && /^(?:string|number)$/.test(typeof content) || privateField(content));
    if (privateField(value) || Object.keys(vars ?? {}).some(key => /token|secret|password|credential|api[_-]?key/i.test(key))) errors.push('秘密不能写进仓库；Bot Token 必须放 Cloudflare Secret');
    if (!vars || typeof vars !== 'object' || Array.isArray(vars)) errors.push('vars 必须是对象');
    if (!vars || typeof vars.DISCORD_APPLICATION_ID !== 'string' || !/^\d{17,20}$/.test(vars.DISCORD_APPLICATION_ID)) errors.push('Application ID 必须是 17–20 位数字字符串');
    if (!vars || typeof vars.DISCORD_PUBLIC_KEY !== 'string' || !/^[0-9a-f]{64}$/i.test(vars.DISCORD_PUBLIC_KEY)) errors.push('Public Key 必须是 64 位十六进制字符串');
    if (vars?.HANDOFF_TTL_SECONDS !== undefined && !/^[1-9]\d*$/.test(String(vars.HANDOFF_TTL_SECONDS))) errors.push('HANDOFF_TTL_SECONDS 必须是正整数');
    return result(!errors.length, { errors, formatOnly: true });
  }
  function githubData(fork, path, branch = 'main') {
    if (!fork || location.hostname !== 'github.com') return null;
    const found = [];
    for (const node of document.querySelectorAll('script[type="application/json"][data-target="react-app.embeddedData"]')) {
      try {
        const payload = JSON.parse(node.textContent).payload;
        const layout = payload?.codeViewLayoutRoute;
        if (layout?.repo?.ownerLogin + '/' + layout?.repo?.name !== fork || layout?.refInfo?.name !== branch || layout.path !== path || !/^[a-f0-9]{40}$/i.test(layout.refInfo.currentOid || '')) continue;
        found.push(payload);
      } catch { /* Page data is not executable code. Unknown schemas are not evidence. */ }
    }
    return found.length === 1 ? found[0] : null;
  }
  function committedFile(fork, branch = 'main', path = 'wrangler.jsonc') {
    const payload = githubData(fork, path, branch);
    const layout = payload?.codeViewBlobLayoutRoute;
    const lines = payload?.['codeViewBlobLayoutRoute.StyledBlob']?.rawLines;
    if (!layout || layout.path !== path || layout.refInfo?.name !== branch || layout.refInfo.currentOid !== payload.codeViewLayoutRoute.refInfo.currentOid || layout.blob?.truncated !== false || layout.blob?.large !== false || layout.blob?.viewable !== true || !Array.isArray(lines) || !lines.length || lines.some(line => typeof line !== 'string')) return null;
    const source = lines.join('\n');
    return source.length <= 100000 ? source : null;
  }
  function savedConfiguration(fork, branch, path) {
    const content = document.querySelector('textarea#read-only-cursor-text-area,textarea[data-testid="read-only-cursor-text-area"]');
    const lines = [...document.querySelectorAll('td.blob-code')];
    return committedFile(fork, branch, path) ?? (content ? content.value : lines.length ? lines.map(el => el.textContent).join('\n') : null);
  }
  function currentRevision(fork, path, branch = 'main') {
    if (!fork || location.hostname !== 'github.com') return '';
    const payload = githubData(fork, path, branch);
    if (payload) return payload.codeViewLayoutRoute.refInfo.currentOid.toLowerCase();
    const revisions = new Set();
    for (const el of document.querySelectorAll('a[href]')) {
      if (!visible(el)) continue;
      const path = new URL(el.href, location.href).pathname;
      if (path.startsWith('/' + fork + '/commit/') && /^[a-f0-9]{40}$/i.test(path.split('/').at(-1))) revisions.add(path.split('/').at(-1).toLowerCase());
    }
    return revisions.size === 1 ? [...revisions][0] : '';
  }
  return (operation, payload) => {
    if (operation === 'watch-installation') {
      const client = new URL(location.href).searchParams.get('client_id');
      if (location.hostname !== 'discord.com' || !/^\/(?:api\/)?oauth2\/(?:authorize|authorized)\/?$/.test(location.pathname) || !/^\d{17,20}$/.test(payload.expectedApplicationId || '') || (client ? client !== payload.expectedApplicationId : payload.installationStarted !== true) || !/^srl-[a-f0-9-]{36}$/.test(payload.marker || '')) return result(false);
      window.__srlDiscordInstallationCancel?.();
      const completed = () => {
        if ([...document.querySelectorAll('input[type="password"]')].some(rendered)) return false;
        // Only public completion captions. Login fields, values and OAuth parameters are not read or returned.
        const texts = [...document.querySelectorAll('h1,h2,p,span,div,[role="status"]')]
          .filter(el => rendered(el) && !el.childElementCount && !el.closest('form,button,[role="button"]'))
          .map(el => el.textContent.trim());
        return texts.some(text => /^(?:success[!！]?|成功[!！]?)$/i.test(text)) &&
          texts.some(text => /已(?:获得授权|授权).*(?:添加|安装)|(?:authori[sz]ed|added).*(?:app|application|server)|successfully.*(?:authori[sz]ed|added|installed)/i.test(text)) &&
          texts.some(text => /(?:可以|现在).*(?:关闭).*(?:窗口|标签)|(?:may|can).*close.*(?:window|tab)/i.test(text));
      };
      let observer;
      const cancel = () => { observer?.disconnect(); if (window.__srlDiscordInstallationCancel === cancel) delete window.__srlDiscordInstallationCancel; };
      const notify = () => { if (!completed()) return false; cancel(); console.info('SRL_DISCORD_INSTALLED:' + payload.marker); return true; };
      window.__srlDiscordInstallationCancel = cancel;
      if (notify()) return result(true, { installationCompleted: true });
      observer = new MutationObserver(notify);
      observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class','style','hidden','aria-hidden'] });
      return result(true, { observing: true, installationCompleted: false });
    }
    if (operation === 'prepare-secret' || operation === 'submit-secret' || operation === 'fill-stored-secret') return secretOperation(operation, payload);
    if (operation === 'capture-bot-secret') {
      if (location.href !== 'https://discord.com/developers/applications/' + payload.expectedApplicationId + '/bot' || !/^[0-9]{17,20}$/.test(payload.expectedApplicationId || '')) return result(false, { reason: 'wrong-app' });
      const tokenCaption = text => /^(bot\s*token|token|机器人\s*(?:token|令牌)|令牌)$/i.test(String(text || '').trim());
      if ([...document.querySelectorAll('input[type="password"]')].some(el => rendered(el) && !tokenCaption(fieldCaption(el)))) return result(false, { reason: 'verification-required' });
      const values = new Set();
      const read = node => {
        if (!rendered(node) || node.type === 'hidden' || node.type === 'password' || /current-password|new-password/.test(node.autocomplete || '')) return;
        const texts = ['INPUT','TEXTAREA'].includes(node.tagName) ? [node.value] : [...node.childNodes].filter(child => child.nodeType === 3).map(child => child.textContent);
        for (const text of texts) {
          const value = String(text || '').trim();
          if (value.length <= 512 && /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}$/.test(value)) values.add(value);
        }
      };
      [...document.querySelectorAll('input,textarea')].filter(el => tokenCaption(fieldCaption(el))).forEach(read);
      const labels = [...document.querySelectorAll(captionSelector+',span,div')].filter(el => rendered(el) && (!el.childElementCount || el.tagName === 'LABEL') && tokenCaption(el.textContent));
      for (const name of labels.slice(0, 8)) {
        const linked = name.control || name.htmlFor && document.getElementById(name.htmlFor);
        if (linked) { read(linked); continue; }
        if (name.tagName === 'DT' && name.nextElementSibling?.tagName === 'DD') { read(name.nextElementSibling); continue; }
        let scope = name.parentElement;
        for (let depth = 0; scope && depth < 3; depth++, scope = scope.parentElement) {
          if (scope.matches('body,html,main,form,[role="main"]') || captions(scope).some(other => other !== name && !tokenCaption(other.textContent))) break;
          [...scope.querySelectorAll('input,textarea,code,output,span,dd,div')].filter(node => node !== name).slice(0, 16).forEach(read);
          if (values.size) break;
        }
      }
      // Only this user-confirmed, same-App local capture may inspect token-shaped values.
      // Caption changes must not force the user to reproduce a tutorial's DOM layout.
      if (!values.size) [...document.querySelectorAll('input,textarea,code,output,span,dd,div')].forEach(read);
      return values.size === 1 ? result(true, { secret: [...values][0] }) : result(false, { reason: values.size > 1 ? 'ambiguous-token' : 'token-not-displayed' });
    }
    if (operation === 'cancel-wait') { window.__srlDiscordCancelWait?.(); return result(true); }
    const secretPage = secretLocation() && (/\/settings(?:\/|$)/.test(location.pathname) || secretForm() || variableTable());
    const publicSecretControls = secretPage && (!payload.secretStage || ['prepare','submit','saved'].includes(payload.secretStage));
    if (operation === 'inspect' && secretPage && ['input','submitted'].includes(payload.secretStage)) {
      const saved = secretSavedOnPage();
      const wait = payload.secretStage === 'input' && !saved;
      return result(!wait, { secretSavedOnPage: saved, waitingForUser: wait });
    }
    if (operation === 'inspect' && secretPage && (!payload.secretStage || ['prepare','submit','saved'].includes(payload.secretStage))) {
      const form = secretForm(payload);
      if ([...document.querySelectorAll('input[type="password"]')].some(el => visible(el) && el !== form?.valueElement && !/value|值/i.test(fieldCaption(el)))) return result(false, { waitingForUser: true, pageAccess: 'authentication' });
      return secretControls(payload);
    }
    if (secretPage && !publicSecretControls) return result(false, { waitingForUser: true });
    if (location.hostname === 'discord.com' && /\/bot(?:\/|$)/.test(location.pathname) || location.hostname === 'dash.cloudflare.com' && (/\/(api-tokens|tokens|security)(\/|$)/.test(location.pathname) || /\/settings(?:\/|$)/.test(location.pathname) && !location.pathname.includes('/d1/') && !secretLocation() || !publicSecretControls && (secretForm() || variableTable()))) return result(false, { waitingForUser: true });
    if (!publicSecretControls && login() && !payload.general) return result(false, { waitingForUser: true, pageAccess: 'authentication' });
    if (publicSecretControls && !['click','select','focus','scroll','fill'].includes(operation) && !(operation === 'collect-worker' && !secretForm() && !variableTable())) return result(false, { errors: ['本页可自主查找和操作公开控件；密钥值仅由本机 transfer-secret 或用户填写'] });
    if (operation === 'watch-status' || operation === 'check-status') {
      if (!/^\d{1,10}$/.test(payload.target)) return result(false);
      const nodes = document.querySelectorAll('[data-srl-discord-control="' + payload.target + '"]');
      const el = nodes.length === 1 ? nodes[0] : null;
      const pending = node => /pending|building|running|queued|deploying|等待|排队|构建|部署中/i.test(node.textContent) && !/\b(?:failed|error|cancelled|canceled)\b|失败|错误|已取消/i.test(node.textContent);
      if (operation === 'check-status') return result(true, { changed: !el || !visible(el) || !pending(el) });
      if (!el || !visible(el) || label(el) !== payload.label || secret(el) || el.closest('form') || (!['status','alert'].includes(el.getAttribute('role')) && el.getAttribute('data-srl-discord-result') !== 'true') || !pending(el) || !/^srl-[a-f0-9-]{36}$/.test(payload.marker || '')) return result(false, { errors: ['只能等待当前真实的构建/部署/同步状态，不能空等或重复轮询'] });
      window.__srlDiscordCancelWait?.();
      const url = location.href;
      let observer;
      const cancel = () => { observer?.disconnect(); if (window.__srlDiscordCancelWait === cancel) delete window.__srlDiscordCancelWait; };
      observer = new MutationObserver(records => {
        if (location.href !== url) { cancel(); return; }
        if (!el.isConnected || records.some(record => record.target === el || el.contains(record.target) || record.type === 'attributes' && record.target.contains(el)) && (!visible(el) || !pending(el))) { cancel(); console.info('SRL_DISCORD_READY:' + payload.marker); }
      });
      window.__srlDiscordCancelWait = cancel;
      observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden','class','style','aria-hidden','aria-label','title'] });
      return result(true, { observing: true });
    }
    if (operation === 'privacy-check') return result(true, { pageAccess: login() ? 'authentication' : [...document.querySelectorAll('input,textarea,select,[contenteditable="true"]')].some(el => rendered(el) && fieldInfo(el).sensitive) ? 'protected' : 'public' });
    if (operation === 'inspect') {
      const query = typeof payload.query === 'string' ? payload.query.trim() : '';
      if (query.length > 80 || safe(query) !== query || /[\x00-\x1f]/.test(query)) return result(false, { errors: ['搜索只接受简短的页面标签或标题，不接受配置值'] });
      const normalize = text => safe(text).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
      const terms = normalize(query).split(' ').filter(Boolean);
      const matchesQuery = text => !query || terms.every(term => normalize(text).includes(term));
      const eligible = rendered;
      const limit = query ? 25 : 100;
      let sequence = Number(payload.startSequence) || 0;
      for (const el of document.querySelectorAll('[data-srl-discord-control]')) el.removeAttribute('data-srl-discord-control');
      const controls = [];
      const privateReferences = [...document.querySelectorAll('input,textarea,select')]
        .filter(el => secret(el) || fieldInfo(el).sensitive)
        .flatMap(el => ['aria-labelledby','aria-describedby','aria-errormessage'].flatMap(name => (el.getAttribute(name) || '').split(/\s+/).filter(Boolean)))
        .map(id => document.getElementById(id)).filter(Boolean);
      for (const el of document.querySelectorAll('a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="combobox"],[role="listbox"],[role="menu"],[role="option"],[role="checkbox"],[role="radio"],[role="switch"],[role="status"],[role="alert"]')) {
        if (!eligible(el) || el.closest('.cm-editor,.CodeMirror,.monaco-editor')) continue;
        const info = ['INPUT','TEXTAREA'].includes(el.tagName) ? fieldInfo(el) : null;
        const text = info?.label || label(el); if (!text || !matchesQuery(text) || query && (secret(el) || fieldInfo(el).sensitive)) continue;
        const target = String(++sequence);
        el.setAttribute('data-srl-discord-control', target);
        controls.push({ target, label: text, kind: el.getAttribute('role') || el.tagName.toLowerCase(), sensitive: info?.sensitive ?? secret(el), ...(disabled(el) ? { disabled: true } : {}), visible: visible(el), ...(query ? { context: safe(fieldCaption(el)) } : {}), ...(['checkbox','radio'].includes(el.type) || ['checkbox','radio','switch','menuitemcheckbox','menuitemradio','option'].includes(el.getAttribute('role')) ? { checked: el.checked ?? (el.getAttribute('aria-checked') || el.getAttribute('aria-selected')) === 'true' } : {}), ...(el.getAttribute('role') === 'tab' ? { checked: el.getAttribute('aria-selected') === 'true' } : {}) });
        if (info && !info.sensitive && el.getAttribute('aria-invalid') === 'true') {
          const ids = (el.getAttribute('aria-errormessage') || el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
          controls[controls.length - 1].invalid = true;
          controls[controls.length - 1].feedback = ids.slice(0, 3).map(id => document.getElementById(id)).filter(node => node && rendered(node) && !node.querySelector('input,textarea,select') && !secret(node) && !fieldInfo(node).sensitive).map(node => safe(node.textContent));
        }
        if (el.tagName === 'SELECT' && !secret(el) && !disabled(el)) for (const option of el.options) {
          if (controls.length >= limit) break;
          if (option.disabled || !option.textContent.trim() || !matchesQuery(option.textContent)) continue;
          const optionTarget = String(++sequence); option.setAttribute('data-srl-discord-control', optionTarget);
          controls.push({ target: optionTarget, label: safe(option.textContent), kind: 'option', sensitive: false, checked: option.selected });
        }
        if (controls.length >= limit) break;
      }
      if (publicParameterPage()) {
        for (const el of document.querySelectorAll('input:not([type="hidden"]),textarea,code,output,dd,span,div')) {
          if (controls.length >= limit) break;
          if (!eligible(el) || el.hasAttribute('data-srl-discord-control') || el.childElementCount) continue;
          const info = fieldInfo(el);
          if (!info.label || info.sensitive || !matchesQuery(info.label)) continue;
          const target = String(++sequence);
          el.setAttribute('data-srl-discord-control', target);
          controls.push({ target, ...info, kind: 'parameter-field', ...(query ? { visible: visible(el) } : {}) });
        }
      }
      for (const el of document.querySelectorAll('p,span,div,h1,h2,h3,h4,h5,h6,code,output,dt,dd,td,th,li')) {
        if (controls.length >= limit) break;
        if (!eligible(el) || el.childElementCount || el.closest('.cm-editor,.CodeMirror,.monaco-editor') || el.hasAttribute('data-srl-discord-control') || secret(el) || fieldInfo(el).sensitive || privateReferences.some(node => node.contains(el))) continue;
        const text = el.textContent.trim();
        const publicFailure = /\bcannot\b|\bnot allowed\b|\binvalid\b|\balready exists\b|\brequired\b|\berror\b|\bfailed\b|不允许|不能|无效|已存在|不能为空|错误|失败|冲突/i.test(text) && !/password|token|secret|credential|验证码|密码|密钥|令牌/i.test(text);
        if (el.closest('form') && !publicFailure) continue;
        // Public observations need not use a tutorial's vocabulary. Parameter values stay local.
        if (!text || text.length > 180 || /\b(?:\d{17,20}|[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\b/i.test(text) || query && !matchesQuery(text)) continue;
        const knownStatus = publicFailure || /success|deployed|\bactive\b|current deployment|pending|building|running|queued|deploying|up to date|up-to-date|behind|ahead|conflict|部署成功|当前部署|已生效|已同步|最新|失败|冲突|等待|排队|构建|部署中/i.test(text);
        if (!query && !knownStatus && el.matches(captionSelector)) continue; // Already present in headings.
        const target = String(++sequence); el.setAttribute('data-srl-discord-control', target); el.setAttribute('data-srl-discord-result', 'true');
        controls.push({ target, label: safe(text), kind: knownStatus ? 'result-text' : 'public-text', sensitive: false, visible: visible(el), context: safe(fieldCaption(el)) });
      }
      const forkOfTarget = forkRelation();
      const applications = applicationList();
      const headings = captions(document).filter(eligible);
      const pageAccess = login() ? 'authentication' : [...document.querySelectorAll('input,textarea,select,[contenteditable="true"]')].some(el => rendered(el) && fieldInfo(el).sensitive) ? 'protected' : 'public';
      const extra = {};
      if (payload.general) {
        extra.title = safe(document.title || '');
        extra.pageAccess = pageAccess;
        const main = document.querySelector('main,[role="main"],article') || document.body;
        const content = [...main.querySelectorAll('p,li,dt,dd,h1,h2,h3,h4,td,th,pre,[role="status"],[role="alert"],output')].filter(el => rendered(el) && !secret(el) && !el.closest('input,textarea,select,[contenteditable="true"]')).map(el => safe(el.textContent)).join('\n');
        extra.text = content.slice(0, 2400);
        if (query && content.toLocaleLowerCase().includes(query.toLocaleLowerCase())) extra.searchMatched = true;
        const selectedRegions = [...document.querySelectorAll('main,[role="main"],article,section')].filter(eligible).slice(0, 30);
        extra.regions = selectedRegions.map(el => {
          const target = String(++sequence); el.setAttribute('data-srl-discord-control', target);
          return { target, label: safe(fieldCaption(el) || label(el) || el.tagName.toLowerCase()) };
        });
        const selectedForms = [...document.forms].filter(eligible).slice(0, 30);
        extra.forms = selectedForms.map(form => {
          const target = String(++sequence); form.setAttribute('data-srl-discord-control', target);
          return { target, label: safe(fieldCaption(form) || form.getAttribute('aria-label') || form.getAttribute('name') || '表单'), controls: form.querySelectorAll('input,textarea,select,button').length, invalid: !!form.querySelector('[aria-invalid="true"]') };
        });
        extra.links = [...document.querySelectorAll('a[href]')].filter(el => eligible(el) && !secret(el)).slice(0, 50).map(el => {
          const target = el.getAttribute('data-srl-discord-control') || String(++sequence);
          el.setAttribute('data-srl-discord-control', target);
          let url = '';
          try { const parsed = new URL(el.href, location.href); if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) { parsed.search = ''; parsed.hash = ''; url = parsed.href; } } catch {}
          return { target, label: safe(label(el)), url, disabled: disabled(el) };
        }).filter(item => item.label && item.url);
      }
      return result(true, { controls, forkOfTarget, ...(repositoryIdentity() ? { repository: repositoryIdentity() } : {}), pageAccess, waitingForUser: payload.general && pageAccess !== 'public', pageKind: pageKind(), headings: headings.slice(0, 12).map(el => safe(el.textContent)), ...(applications ? { applicationList: applications } : {}), truncated: controls.length >= limit, ...(query ? { searchMatched: controls.length > 0 || headings.some(el => matchesQuery(el.textContent)) } : {}), ...extra });
    }
    if (operation === 'download-target') {
      const el = document.querySelector('[data-srl-discord-control="' + payload.target + '"]');
      if (!payload.general || !el?.matches('a[href]') || secret(el)) return result(false);
      return result(true, { downloadUrl: el.href, fileName: el.getAttribute('download') || '' });
    }
    if (operation === 'read-page') {
      if (!payload.general) return result(false);
      const offset = Number.isInteger(payload.offset) && payload.offset >= 0 ? payload.offset : 0;
      const limit = Math.max(200, Math.min(4000, Number(payload.limit) || 2400));
      const query = typeof payload.query === 'string' ? payload.query.trim() : '';
      if (query.length > 80 || safe(query) !== query || /[\x00-\x1f]/.test(query)) return result(false, { errors: ['关键词最多80字'] });
      let root = document.querySelector('main,[role="main"],article') || document.body;
      if (payload.regionTarget) {
        if (!/^\d{1,10}$/.test(payload.regionTarget)) return result(false);
        const matches = document.querySelectorAll('[data-srl-discord-control="' + payload.regionTarget + '"]');
        if (matches.length !== 1 || !rendered(matches[0])) return result(false, { staleTarget: true });
        root = matches[0];
      }
      const clone = root.cloneNode(true);
      clone.querySelectorAll('script,style,noscript,svg,form,input,textarea,select,button,[contenteditable="true"],[hidden],[aria-hidden="true"],iframe,canvas').forEach(el => el.remove());
      clone.querySelectorAll('*').forEach(el => { if (secret(el) || fieldInfo(el).sensitive) el.remove(); });
      let text = (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim()
        .replace(/([?&](?:code|token|access_token|refresh_token|id_token|password|secret|client_secret|api_key)=)[^&#\s]+/gi, '$1[已遮蔽]')
        .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}|(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{20,}/g, '[已遮蔽]')
        .replace(/\b[A-Za-z0-9+/=_-]{24,}\b/g, '[疑似凭据已遮蔽]');
      if (query) { const terms = query.toLowerCase().split(/\s+/).filter(Boolean); text = text.split(/(?<=[.!?。！？])\s+/).filter(line => terms.every(term => line.toLowerCase().includes(term))).join('\n'); }
      const page = text.slice(offset, offset + limit);
      return result(true, { title: safe(document.title || ''), text: page, nextOffset: offset + limit < text.length ? offset + limit : null, truncated: offset + limit < text.length, pageAccess: login() ? 'authentication' : 'public' });
    }
    if (operation === 'verify-step') {
      if (!payload.autonomous) return result(false);
      if (payload.step === 'github-save') {
        if (location.hostname !== 'github.com' || location.pathname !== '/' + payload.expectedFork + '/blob/' + encodeURIComponent(payload.expectedBranch || 'main').replace(/%2F/gi, '/') + '/' + (payload.expectedFile || 'wrangler.jsonc')) return result(false);
        const source = savedConfiguration(payload.expectedFork, payload.expectedBranch || 'main', payload.expectedFile || 'wrangler.jsonc');
        const check = validate(source);
        if (!check.ok) return check;
        const parsed = configuration(source), vars = parsed.vars, db = parsed.d1_databases.find(row => row.binding === 'DB');
        const revision = currentRevision(payload.expectedFork, payload.expectedFile || 'wrangler.jsonc', payload.expectedBranch || 'main');
        const verified = !!revision && vars.DISCORD_APPLICATION_ID === payload.expectedApplicationId && vars.DISCORD_PUBLIC_KEY === payload.expectedPublicKey && db.database_id === payload.expectedDatabaseId;
        return result(verified, { verified, ...(verified ? { revision } : {}) });
      }
      if (payload.step === 'discord-endpoint') {
        if (!/^\d{17,20}$/.test(payload.expectedApplicationId || '') || location.hostname !== 'discord.com' || !location.pathname.startsWith('/developers/applications/' + payload.expectedApplicationId + '/')) return result(false);
        const fields = endpointFields(payload);
        const dirty = [...document.querySelectorAll('button,[role="button"]')].some(el => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && /^(save|save changes|保存|保存更改)$/i.test(label(el).trim()));
        const errors = [...document.querySelectorAll('[role="alert"]')].some(el => visible(el) && /error|failed|invalid|错误|失败|无效/i.test(el.textContent));
        const verified = fields.length === 1 && fields[0].value === payload.value && !dirty && !errors;
        return result(verified, { verified });
      }
      const status = payload.statusTarget;
      if (!status || !/^\d{1,10}$/.test(status.target)) return result(false, { errors: ['请选择当前页面的真实结果状态；点击回执不是成功证据'] });
      const matches = document.querySelectorAll('[data-srl-discord-control="' + status.target + '"]');
      const el = matches.length === 1 ? matches[0] : null;
      if (!el || !visible(el) || label(el) !== status.label || (!['status','alert'].includes(el.getAttribute('role')) && el.getAttribute('data-srl-discord-result') !== 'true') || el.closest('form') || secret(el)) return result(false);
      const text = el.textContent.trim();
      if (payload.step === 'github-sync') {
        const branch = payload.expectedBranch || 'main';
        const onBranch = repositoryIdentity()?.branch === branch || [...document.querySelectorAll('button,a,[role="button"]')].some(node => visible(node) && [branch, branch + ' branch'].includes(label(node).trim()));
        const revision = currentRevision(payload.expectedFork, '', branch);
        const verified = onBranch && !!revision && (payload.synchronizationAssessment === 'current' || /(?:up to date|up-to-date|not behind|0 commits? behind|最新|已同步)/i.test(text)) && !/not (?:up to date|up-to-date)|[1-9]\d* commits? behind|\bbehind\b(?![\s\S]*\b0\b)|failed|conflict|pending|syncing|失败|冲突|落后|同步中/i.test(text.replace(/not behind|0 commits? behind/gi, 'current'));
        return result(verified, { verified, ...(verified ? { revision } : {}) });
      }
      if (payload.step === 'cf-deploy') {
        // Deployment is the milestone here; repository labels and health belong to other checks.
        const workerPage = location.hostname === 'dash.cloudflare.com' && /^\/[^/]+\/workers\/services\/view\/[^/]+(?:\/.*)?$/.test(location.pathname);
        const productionPage = /\/(?:production|deployments)(?:\/|$)/.test(location.pathname) && !/\/(?:settings|builds)(?:\/|$)/.test(location.pathname);
        const deployed = /^(?:(?:deployment|production) )?(?:deployed(?: successfully)?|部署成功|已部署|已生效)$/i.test(text);
        const activeDeployment = !/\/(?:settings|builds|versions|preview)(?:\/|$)/.test(location.pathname) && /^(?:(?:active|current) deployment|production deployment active|当前部署|已生效部署)$/i.test(text);
        // The agent may interpret changed public wording, but must select live evidence.
        const assessed = payload.deploymentAssessment === 'deployed' && !/\/(?:settings|builds|versions|preview)(?:\/|$)/.test(location.pathname);
        const contradicted = /\b(?:pending|building|queued|deploying|failed|error|cancelled|canceled)\b|等待|排队|构建中|部署中|失败|错误|已取消/i.test(text) || /^(?:running|build\s+(?:successful|success)|构建成功)$/i.test(text);
        const verified = workerPage && !contradicted && (assessed || deployed || activeDeployment || productionPage && /^(?:(?:deployment|production) )?(?:success(?:ful)?|active|成功)$/i.test(text));
        return result(verified, { verified });
      }
      return result(false);
    }
    if (operation === 'collect-config') {
      if (!payload.allowParameters) return result(false);
      // Read labelled fields or an observed D1 identity; never scan a whole page or a Bot/Secret form.
      function readField(names, pattern, target, identity) {
        const found = new Set();
        const read = node => {
            if (!rendered(node) || fieldInfo(node).sensitive || node.type === 'hidden' || node.type === 'password') return;
            const value = String(['INPUT','TEXTAREA'].includes(node.tagName) ? node.value : node.textContent || '').trim();
            if (value.length <= 64 && pattern.test(value)) found.add(value);
        };
        if (target) {
          if (!/^[0-9]{1,10}$/.test(target.target || '')) return;
          const nodes = [...document.querySelectorAll('[data-srl-discord-control="'+target.target+'"]')];
          if (nodes.length !== 1 || !['INPUT','TEXTAREA','CODE','OUTPUT','DD','SPAN','DIV'].includes(nodes[0].tagName) || nodes[0].childElementCount || fieldInfo(nodes[0]).label !== target.label) return;
          read(nodes[0]);
        } else {
          const labels = [...document.querySelectorAll(captionSelector+',span,div')].filter(el => (!el.childElementCount || el.tagName === 'LABEL') && rendered(el) && names.includes(el.textContent.trim().toLowerCase()));
          for (const label of labels.slice(0, 8)) {
            const linked = label.control || label.htmlFor && document.getElementById(label.htmlFor);
            if (linked) { read(linked); continue; }
            if (label.tagName === 'DT' && label.nextElementSibling?.tagName === 'DD') { read(label.nextElementSibling); continue; }
            let scope = label.parentElement;
            for (let depth = 0; scope && depth < 3; depth++, scope = scope.parentElement) {
              if (scope.matches('body,html,main,form,[role="main"]') || captions(scope).some(other => other !== label && !names.includes(other.textContent.trim().toLowerCase()))) break;
              const nodes = [...scope.querySelectorAll('input:not([type="hidden"]),textarea,code,output,span,dd,div')].filter(node => !node.childElementCount && node !== label).slice(0, 16);
              nodes.forEach(read);
              if (found.size) break;
            }
          }
        }
        if (identity) {
          if ([...found].some(value => value.toLowerCase() !== identity)) return;
          if (!target || found.size === 1) return identity;
        }
        return found.size === 1 ? [...found][0] : undefined;
      }
      if (payload.step === 'discord-app' && location.hostname === 'discord.com' && /^\/developers\/applications\/\d{17,20}(?:\/|$)/.test(location.pathname)) {
        const applicationId = readField(['application id','应用程序 id','应用程序id','应用 id'], /^\d{17,20}$/, payload.applicationIdTarget);
        const publicKey = readField(['public key','公钥'], /^[a-f0-9]{64}$/i, payload.publicKeyTarget);
        if (!applicationId || !publicKey) return result(false, { errors: [(applicationId ? 'Public Key' : 'Application ID') + ' 字段未识别到唯一有效值。请 inspect 查看标题和字段关系，必要时滚动后选择实际字段 target；不要原样反复读取。'] });
        if (applicationId !== location.pathname.split('/')[3] || payload.expectedApplicationId && applicationId !== payload.expectedApplicationId) return result(false, { errors: ['读取的 Application ID 与当前 App 不一致，未保存。'] });
        return result(true, { parameters: { applicationId, publicKey } });
      }
      if (payload.step === 'd1-uuid' && location.hostname === 'dash.cloudflare.com' && /\/d1(?:\/|$)/.test(location.pathname)) {
        const identity = d1DatabaseId(location.href);
        const target = payload.databaseIdTarget;
        const selected = target && /^[0-9]{1,10}$/.test(target.target || '') ? [...document.querySelectorAll('[data-srl-discord-control="'+target.target+'"]')] : [];
        if (selected.length === 1 && selected[0].tagName === 'A') {
          const link = selected[0], databaseId = d1DatabaseId(link.href);
          return rendered(link) && !fieldInfo(link).sensitive && label(link) === target.label && databaseId && (!identity || identity === databaseId) ? result(true, { parameters: { databaseId } }) : result(false, { errors: ['所选链接不是本次数据库的详情链接，请重新 inspect 按数据库名称定位。'] });
        }
        const databaseId = readField(['database id','数据库 id','数据库id','database uuid','uuid','数据库 uuid','数据库uuid'], /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i, target, identity);
        return databaseId ? result(true, { parameters: { databaseId } }) : result(false, { errors: ['未识别到与本次数据库一致的唯一 UUID。详情页不必显示 UUID：请 inspect 返回 D1 列表，按库名选择实际数据库链接或 UUID 字段 target；不要原样反复读取或切换助手模式。'] });
      }
      return result(false, { errors: [pageKind() === 'discord-app-list' ? '当前是应用列表，先选择自己的 App 再进入 General Information；列表不提供 Public Key。' : '当前不是 App 的 General Information 或 D1 详情页，请先定位并打开正确的信息页。'] });
    }
    if (operation === 'validate') {
      const edit = editor();
      const source = edit ? edit.read() : savedConfiguration(payload.expectedFork, payload.expectedBranch || 'main', payload.expectedFile || 'wrangler.jsonc'); const check = validate(source);
      if (check.ok && payload.expectedApplicationId && configuration(source).vars.DISCORD_APPLICATION_ID !== payload.expectedApplicationId) return result(false, { errors: ['Application ID 与前面选择的 Discord App 不一致'] });
      return check;
    }
    if (operation === 'guide') {
      if (payload.target && /^\d{1,10}$/.test(payload.target)) {
        const nodes = document.querySelectorAll('[data-srl-discord-control="' + payload.target + '"]');
        const el = nodes.length === 1 ? nodes[0] : null;
        const caption = el && publicParameterPage() && ['INPUT','TEXTAREA'].includes(el.tagName) ? fieldInfo(el).label || label(el) : el && label(el);
        if (!el || !visible(el) || caption !== payload.label) return result(false, { errors: ['指路目标已变化，请重新观察页面'] });
        highlight([el]); return result(true, { waitingForUser: true, guideAnchor: anchor(el), guideText: '请在标出的位置完成登录或授权，完成后点我继续。' });
      }
      const names = payload.step === 'discord-app' ? ['application id', 'public key', '应用程序 id', '应用程序id', '应用 id', '公钥'] : payload.step === 'd1-uuid' ? ['database id', '数据库 id', '数据库id'] : payload.step === 'discord-install' ? ['installation', 'install link', 'user install', '安装', '安装链接'] : payload.step === 'discord-endpoint' ? ['interactions endpoint url'] : ['d1', 'workers & pages'];
      const matches = payload.step === 'wrangler-edit' || payload.step === 'wrangler-check' ? [editor()?.element].filter(Boolean) : [...document.querySelectorAll('label,dt,h1,h2,h3,h4,span')].filter(el => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && names.includes(el.textContent.trim().toLowerCase())).slice(0, 8);
      highlight(matches);
      if (!matches[0]) return result(false, { errors: ['当前页面没有找到对应位置，请先打开正确的配置页'] });
      const target = (matches[0].htmlFor && document.getElementById(matches[0].htmlFor)) || matches[0];
      target.scrollIntoView({ block: 'center', behavior: 'instant' });
      const rect = target.getBoundingClientRect();
      if (!visible(target)) return result(false);
      const guideAnchor = { left: Math.max(0, rect.left / innerWidth), top: Math.max(0, rect.top / innerHeight), right: Math.min(1, rect.right / innerWidth), bottom: Math.min(1, rect.bottom / innerHeight) };
      const guideText = payload.step.startsWith('wrangler-') ? '在这里填写 D1 UUID、Application ID、Public Key 三个空；填好点我继续。' : '配置位置已标出。请在网页保存或填写，填好点我继续。';
      return result(true, { guideAnchor, guideText, waitingForUser: true });
    }
    if (operation === 'fill-endpoint' || operation === 'open-install') {
      const rendered = el => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
      if (!/^\d{17,20}$/.test(payload.expectedApplicationId || '') || location.hostname !== 'discord.com' || !location.pathname.startsWith('/developers/applications/' + payload.expectedApplicationId + '/') || payload.step !== (operation === 'fill-endpoint' ? 'discord-endpoint' : 'discord-install')) return result(false);
      if (operation === 'fill-endpoint') {
        let url; try { url = new URL(payload.value); } catch { return result(false); }
        if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/interactions') return result(false);
        const fields = endpointFields(payload);
        if (fields.length !== 1) return result(false);
        const field = fields[0];
        const previous = field.value.trim();
        if (previous && previous !== payload.value && payload.confirmedPreviousEndpoint !== previous)
          return result(false, { configurationConflict: true, previousEndpoint: previous });
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, payload.value);
        field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true }));
        if (!field.isConnected || field.value !== payload.value) return result(false);
        highlight([field]); field.scrollIntoView({ block: 'center' });
        return result(true, { filled: true, waitingForUser: !payload.autonomous, guideAnchor: anchor(field), guideText: payload.autonomous ? '交互地址已填好，接下来保存并核验结果。' : '交互地址已填写为 Worker 根网址 + /interactions。请核对，保存并等待 Discord 验证通过。' });
      }
      const urls = new Set();
      // Only public installation links for this App. No custom redirects.
      let installNodes = [...document.querySelectorAll('a[href],input[readonly]')];
      if (payload.target) {
        if (!/^\d{1,10}$/.test(payload.target)) return result(false);
        installNodes = [...document.querySelectorAll('[data-srl-discord-control="' + payload.target + '"]')];
        if (installNodes.length !== 1 || label(installNodes[0]) !== payload.label || !installNodes[0].matches('a[href],input[readonly]')) return result(false);
      }
      for (const el of installNodes) {
        if (!rendered(el) || secret(el)) continue;
        const raw = el.tagName === 'A' ? el.href : el.value;
        try {
          const url = new URL(raw);
          const allowed = ['client_id','scope','permissions','integration_type','guild_id','disable_guild_select'];
          if (url.protocol !== 'https:' || url.hostname !== 'discord.com' || url.port || url.username || url.password || url.hash || !['/oauth2/authorize','/api/oauth2/authorize'].includes(url.pathname) || url.searchParams.get('client_id') !== payload.expectedApplicationId || [...url.searchParams.keys()].some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1) || (url.searchParams.get('scope') || '').split(/\s+/).some(scope => scope && !['applications.commands','bot'].includes(scope))) continue;
          urls.add(url.href);
        } catch { /* Other page values are not install links. */ }
      }
      return urls.size === 1 ? result(true, { installUrl: [...urls][0] }) : result(false);
    }
    if (operation === 'collect-worker') {
      if (location.hostname !== 'dash.cloudflare.com') return result(false);
      const worker = location.pathname.match(/^\/[^/]+\/workers\/services\/view\/([^/]+)(?:\/.*)?$/);
      if (!worker) return result(false);
      const urls = new Set();
      let nodes = [...document.querySelectorAll('a[href],input[readonly],textarea[readonly],code,output,dd,span,div,td,li')];
      if (payload.target) {
        if (!/^\d{1,10}$/.test(payload.target)) return result(false);
        nodes = [...document.querySelectorAll('[data-srl-discord-control="' + payload.target + '"]')];
        if (nodes.length !== 1 || label(nodes[0]) !== payload.label) return result(false);
      }
      for (const el of nodes) {
        if (!rendered(el) || secret(el) || fieldInfo(el).sensitive || el.closest('.cm-editor,.CodeMirror,.monaco-editor') || !['A','INPUT','TEXTAREA'].includes(el.tagName) && el.childElementCount) continue;
        const raw = el.tagName === 'A' ? el.href : ['INPUT','TEXTAREA'].includes(el.tagName) ? el.value : el.textContent.trim();
        if (raw.length > 300) continue;
        try { const url = new URL(/^[a-z0-9.-]+\.workers\.dev\/?$/i.test(raw) ? 'https://' + raw : raw); if (url.protocol === 'https:' && url.hostname.startsWith(worker[1] + '.') && url.hostname.endsWith('.workers.dev') && !url.username && !url.password && !url.port && !url.search && !url.hash && url.pathname === '/') urls.add(url.origin); } catch { /* Invalid links are not configuration. */ }
      }
      return urls.size === 1 ? result(true, { workerUrl: [...urls][0] }) : result(false);
    }
    if (operation === 'template') {
      const edit = editor();
      if (!edit || typeof payload.template !== 'string' || payload.template.length > 100000) return result(false, { errors: ['未定位到可读取完整文档的编辑器；inspect 当前文件与编辑入口，在自己 Fork 定位后再填写，不让用户代粘贴'] });
      let written = payload.template;
      if (payload.preserveConfiguration && edit.read().trim()) {
        const original = edit.read(), expected = edit.element.__srlWranglerConfirmation;
        let previous, next, replacementRequired = false, conflict = false;
        try {
          previous = configuration(original); next = configuration(payload.template);
          const bindings = Array.isArray(previous.d1_databases) ? previous.d1_databases.filter(row => row?.binding === 'DB') : [];
          if (bindings.length !== 1 || !previous.vars || typeof previous.vars !== 'object') replacementRequired = true;
          else {
            const db = next.d1_databases.find(row => row.binding === 'DB');
            conflict = ['DISCORD_APPLICATION_ID','DISCORD_PUBLIC_KEY'].some(key => /^[a-f0-9]{17,64}$/i.test(previous.vars[key] || '') && previous.vars[key] !== next.vars[key]) || /^[a-f0-9-]{36}$/i.test(bindings[0].database_id || '') && bindings[0].database_id !== db.database_id;
            bindings[0].database_id = db.database_id;
            previous.vars = { ...previous.vars, DISCORD_APPLICATION_ID: next.vars.DISCORD_APPLICATION_ID, DISCORD_PUBLIC_KEY: next.vars.DISCORD_PUBLIC_KEY };
            written = JSON.stringify(previous, null, 2);
            if (!validate(written).ok) replacementRequired = true;
          }
        } catch { replacementRequired = true; }
        if (replacementRequired) written = payload.template;
        if ((conflict || replacementRequired) && (!expected || expected.id !== payload.configurationConfirmation || expected.source !== original)) {
          const id = crypto.randomUUID(); edit.element.__srlWranglerConfirmation = { id, source: original };
          return result(false, { configurationConflict: true, replacementRequired, configurationConfirmation: id, errors: [replacementRequired ? '已有文件格式/结构无法保留，需确认完整替换，未写入' : '已有不同 App/公钥/D1，需确认切换，未写入'] });
        }
      }
      delete edit.element.__srlWranglerConfirmation;
      edit.write(written);
      if (payload.validateTemplate) {
        const source = edit.read();
        const check = validate(source);
        if (!check.ok) return check;
        if (source !== written || payload.expectedApplicationId && configuration(source).vars.DISCORD_APPLICATION_ID !== payload.expectedApplicationId) return result(false, { errors: ['写入内容与本次 App 配置不一致'] });
        return result(true, { written: true, waitingForUser: !payload.autonomous, formatOnly: true });
      }
      return result(edit.read() === written, { written: edit.read() === written, waitingForUser: edit.read() === written && !payload.autonomous });
    }
    if (operation === 'scroll') {
      if (payload.direction && !['up','down'].includes(payload.direction)) return result(false);
      let scope = document;
      if (payload.target) {
        if (!/^\d{1,10}$/.test(payload.target)) return result(false);
        const matches = document.querySelectorAll('[data-srl-discord-control="' + payload.target + '"]');
        if (matches.length !== 1 || !visible(matches[0]) || label(matches[0]) !== payload.label || disabled(matches[0]) || secret(matches[0]) || fieldInfo(matches[0]).sensitive) return result(false);
        scope = matches[0];
      }
      const panels = [...(scope === document ? [] : [scope]), ...scope.querySelectorAll('main,[role="main"],section,div')].filter(el => visible(el) && el.clientHeight > 100 && el.scrollHeight > el.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(el).overflowY));
      panels.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
      const panel = panels[0] || (scope === document ? document.scrollingElement : null);
      if (!panel) return result(false);
      const before = panel.scrollTop; panel.scrollTop = Math.max(0, Math.min(panel.scrollHeight - panel.clientHeight, before + (payload.direction === 'up' ? -1 : 1) * Math.max(100, panel.clientHeight * 0.7)));
      return result(true, { atEnd: panel.scrollTop + panel.clientHeight >= panel.scrollHeight, moved: panel.scrollTop !== before });
    }
    if (!/^\d{1,10}$/.test(payload.target)) return result(false);
    const matches = document.querySelectorAll('[data-srl-discord-control="' + payload.target + '"]');
    const el = matches.length === 1 ? matches[0] : null;
    if (operation === 'select' && el?.tagName === 'OPTION') {
      const select = el.parentElement?.tagName === 'SELECT' ? el.parentElement : el.parentElement?.parentElement;
      if (!select || select.tagName !== 'SELECT' || !visible(select) || select.disabled || el.disabled || (publicSecretControls ? !secretPublicTarget(select) : secret(select) || fieldInfo(select).sensitive) || safe(el.textContent) !== payload.label) return result(false);
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, el.value);
      select.dispatchEvent(new Event('input', { bubbles: true })); select.dispatchEvent(new Event('change', { bubbles: true }));
      return result(el.selected, { filled: el.selected });
    }
    const currentLabel = el && ['INPUT','TEXTAREA'].includes(el.tagName) ? fieldInfo(el).label || label(el) : el && label(el);
    if (operation === 'focus') {
      const focusLabel = el && publicParameterPage() && ['CODE','OUTPUT','DD','SPAN','DIV'].includes(el.tagName) ? fieldInfo(el).label || currentLabel : currentLabel;
      if (!el || focusLabel !== payload.label || !rendered(el) || (publicSecretControls ? !secretPublicTarget(el) : secret(el) || fieldInfo(el).sensitive)) return result(false, { errors: ['目标已变化或属于私密字段，请重新观察'] });
      const before = visible(el); el.scrollIntoView({ block: 'center', behavior: 'instant' });
      return result(visible(el), { focused: visible(el), moved: !before && visible(el) });
    }
    if (!el || currentLabel !== payload.label || !visible(el)) return result(false, { errors: ['控件已变化或不可用，请重新查看页面'] });
    if (disabled(el)) return result(false, { disabled: true, errors: [repositoryAuthorization() && /^(save|save changes|保存|保存更改)$/i.test(currentLabel.trim())
      ? '网站将此控件标为禁用，未点击，不是代理权限不足。先核对当前授权范围与表单反馈；若已有安装覆盖本次 Fork，无需再保存，返回 Cloudflare 复用授权；确需添加本次仓库时按实际范围修改并核验保存，不为点亮 Save 制造无关改动。'
      : '网站将此控件标为禁用，未操作；请观察实际表单反馈、必填项或已有保存状态，不重复点击，也不把它当成控件变化或权限不足。'] });
    const consentAuthorization = connectionConsent() && operation === 'click' && /^(authorize|授权)/i.test(payload.label.trim());
    if (consentAuthorization && (!payload.autonomous || !captions(document).some(node => /cloudflare(?:[-\s]+workers|[-\s]+pages)/i.test(node.textContent)))) return result(false, { errors: ['未核验为本次 Cloudflare 连接确认页，请观察实际应用名称，不为其他应用授权'] });
    const appAuthorization = repositoryAuthorization() && operation === 'click' && /^(?:(?:install|authorize|save|update)\b|安装|授权|保存)/i.test(payload.label.trim());
    if (appAuthorization) {
      const error = repositoryAuthorizationError(el, payload);
      if (error) return result(false, { errors: [error] });
    }
    if (operation === 'upload' && payload.general && el?.matches('input[type="file"]') && !disabled(el)) {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const rect = el.getBoundingClientRect();
      return result(true, { clickPoint: { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 } });
    }
    const repositoryRemoval = repositoryAuthorization() && /remove.*repository|移除.*仓库/i.test(payload.label);
    if ((publicSecretControls ? !secretPublicTarget(el) : secret(el) || fieldInfo(el).sensitive) || /reset token|discard|delete|sign in|log in|登录|永久删除|重置令牌/i.test(payload.label) || /remove/i.test(payload.label) && !repositoryRemoval || /authorize|授权/i.test(payload.label) && !appAuthorization && !consentAuthorization) return result(false, { waitingForUser: true });
    if (operation === 'press') {
      if (!payload.general || !el || secret(el) || fieldInfo(el).sensitive || disabled(el) || !['INPUT','TEXTAREA','BUTTON','A','SELECT'].includes(el.tagName)) return result(false, { errors: ['按键目标已变化或属于私密控件'] });
      el.focus({ preventScroll: true });
      if (payload.nativeKey) return result(true, { keyDispatch: true });
      const init = { key: payload.key, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent('keydown', init)); el.dispatchEvent(new KeyboardEvent('keyup', init));
      return result(true, { dispatched: true, verified: false });
    }
    if (operation === 'click' || operation === 'select' && el.getAttribute('role') === 'option') {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      if (payload.nativeClick) {
        const rect = el.getBoundingClientRect(), x = (Math.max(0, rect.left) + Math.min(innerWidth, rect.right)) / 2, y = (Math.max(0, rect.top) + Math.min(innerHeight, rect.bottom)) / 2;
        const hit = document.elementFromPoint(x, y);
        if (!visible(el) || disabled(el) || !hit || hit !== el && !el.contains(hit) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return result(false, { errors: ['目标被遮挡或已移出画面，请观察当前浮层和控件，不重复点旧位置'] });
        return result(true, { clickPoint: { x, y } });
      }
      el.click(); return result(true, { dispatched: true, verified: false });
    }
    if (operation === 'fill' && ['INPUT', 'TEXTAREA'].includes(el.tagName) && !el.readOnly && typeof payload.value === 'string') {
      if (el.disabled || !['text','url','search','email','number','tel', undefined].includes(el.tagName === 'INPUT' ? el.type : undefined) || payload.value.length > 4000 || !payload.general && (el.matches('textarea[name="content"],textarea#code-editor,textarea[data-testid="code-editor"]') || el.closest('.cm-editor,.CodeMirror,.monaco-editor'))) return result(false, { errors: ['只填写普通非秘密表单；Wrangler编辑沿本机模板和完整校验'] });
      if (location.hostname === 'discord.com' && /interaction.*(?:endpoint|callback|address|url)|交互.*地址/i.test(currentLabel || '') && el.value.trim() && el.value.trim() !== payload.value)
        return result(false, { configurationConflict: true, previousEndpoint: el.value.trim() });
      const proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, payload.value);
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
      return result(el.value === payload.value, { filled: el.value === payload.value });
    }
    return result(false, { errors: ['当前控件不支持此操作'] });
  };
})()
