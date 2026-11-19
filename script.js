/* =========================================================
 * script.js
 * アンケートアプリ本体（作成画面・回答画面・結果画面）
 *
 * 画面の切り替えは URL のハッシュで行う:
 *   #/              フォーム一覧
 *   #/edit/ID       作成（編集）画面
 *   #/view/ID       回答画面（?preview を付けるとプレビュー表示）
 *   #/done/ID       送信完了画面
 *   #/results/ID    結果画面
 *
 * フォームのデータ構造:
 *   form = {
 *     id, title, description, confirmationMessage, acceptingResponses, createdAt, updatedAt,
 *     pages: [{                         // ページ（セクション）
 *       id, title, description,
 *       next: 'next' | 'submit' | ページID,  // このページの後の移動先
 *       questions: [{
 *         id, type, title, description, required, placeholder,
 *         options: ['選択肢1', ...],     // 選択式
 *         branching: true/false,        // ラジオで「回答に応じて移動」するか
 *         goTo:   ['next' | 'submit' | ページID, ...],  // 選択肢ごとの移動先（options と同じ並び）
 *         endMsg: ['送信後メッセージ', ...],             // 選択肢ごとの送信後メッセージ（任意）
 *         dateStart, dateEnd,           // 日付選択
 *       }]
 *     }]
 *   }
 * ========================================================= */

'use strict';

/* =========================================================
 * 設定（config.js で定義）
 *   REMOTE = true  … 公開モード。回答は Google スプレッドシートに保存し、
 *                     回答者には追いコンの回答画面だけを見せる
 *   REMOTE = false … ローカルモード。ブラウザ内（localStorage）に保存し、作成画面も使える
 * ========================================================= */
const CONFIG = window.APP_CONFIG || {};
const REMOTE = !!CONFIG.API_URL;
const PUBLIC_FORM_ID = 'oikon'; // 公開モードで回答してもらうフォームのID
const OIKON = window.OIKON;     // 追いコンアンケートの内容（config.js）

/* =========================================================
 * データ保存層
 * 画面側はすべて Store.xxx() を await で呼ぶだけなので、
 * 保存先（LocalStore / RemoteStore）を差し替えても画面のコードは変わらない。
 * ========================================================= */

/* ---------- ローカルモード：ブラウザの localStorage に保存 ---------- */
const LocalStore = {
  FORMS_KEY: 'survey.forms',
  RESPONSES_PREFIX: 'survey.responses.',

  _read(key) {
    try {
      return JSON.parse(localStorage.getItem(key)) || [];
    } catch (e) {
      return [];
    }
  },
  _write(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  },

  // フォーム一覧
  async listForms() {
    return this._read(this.FORMS_KEY);
  },
  // フォームを1件取得
  async getForm(id) {
    return this._read(this.FORMS_KEY).find((f) => f.id === id) || null;
  },
  // フォームを保存（なければ追加、あれば上書き）
  async saveForm(form) {
    const forms = this._read(this.FORMS_KEY);
    const i = forms.findIndex((f) => f.id === form.id);
    if (i >= 0) forms[i] = form;
    else forms.push(form);
    this._write(this.FORMS_KEY, forms);
    return form;
  },
  // フォームとその回答を削除
  async deleteForm(id) {
    this._write(this.FORMS_KEY, this._read(this.FORMS_KEY).filter((f) => f.id !== id));
    localStorage.removeItem(this.RESPONSES_PREFIX + id);
  },
  // 回答一覧（古い順）
  async listResponses(formId) {
    return this._read(this.RESPONSES_PREFIX + formId);
  },
  // 回答を1件追加
  async addResponse(formId, answers) {
    const list = this._read(this.RESPONSES_PREFIX + formId);
    const res = { id: uid(), formId, submittedAt: Date.now(), answers };
    list.push(res);
    this._write(this.RESPONSES_PREFIX + formId, list);
    return res;
  },
  // 回答をすべて削除
  async deleteResponses(formId) {
    localStorage.removeItem(this.RESPONSES_PREFIX + formId);
  },
  // 指定した回答だけを削除
  async deleteResponseIds(formId, ids) {
    const set = new Set(ids);
    const key = this.RESPONSES_PREFIX + formId;
    const before = this._read(key);
    const after = before.filter((r) => !set.has(r.id));
    this._write(key, after);
    return before.length - after.length;
  },
};

/* ---------- 公開モード：Google Apps Script 経由でスプレッドシートに保存 ---------- */

// 合言葉が違う・未入力のときのエラー
class AuthError extends Error {}

// 結果を見るための合言葉（管理する人の端末にだけ保存）
const ADMIN_KEY_STORAGE = 'survey.adminKey';
function getAdminKey() {
  try {
    return localStorage.getItem(ADMIN_KEY_STORAGE) || '';
  } catch (e) {
    return '';
  }
}
function setAdminKey(key) {
  try {
    if (key) localStorage.setItem(ADMIN_KEY_STORAGE, key);
    else localStorage.removeItem(ADMIN_KEY_STORAGE);
  } catch (e) {
    // 保存できない環境（プライベートモードなど）では毎回入力してもらう
  }
}

const RemoteStore = {
  // フォームの内容は config.js から作る（ID は固定）
  _forms() {
    const f = oikonForm(true);
    f.acceptingResponses = CONFIG.ACCEPTING !== false;
    return [f];
  },
  async listForms() {
    return this._forms();
  },
  async getForm(id) {
    return this._forms().find((f) => f.id === id) || null;
  },
  // 公開モードではフォームの変更は config.js で行うので保存しない
  async saveForm(form) {
    return form;
  },
  async deleteForm() {},

  // 回答一覧（合言葉が必要）
  async listResponses(formId) {
    const key = getAdminKey();
    if (!key) throw new AuthError();
    const url = `${CONFIG.API_URL}?action=list&formId=${encodeURIComponent(formId)}&key=${encodeURIComponent(key)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.ok) {
      if (data.error === 'unauthorized') throw new AuthError();
      throw new Error(data.error || '読み込みに失敗しました');
    }
    return data.responses.sort((a, b) => a.submittedAt - b.submittedAt);
  },

  // 回答を送信。readable はスプレッドシートで人が読むための列（見出しと値）
  async addResponse(formId, answers, readable = {}) {
    const res = await fetch(CONFIG.API_URL, {
      method: 'POST',
      // text/plain にすると事前確認（CORS プリフライト）が発生せず、Apps Script でそのまま受け取れる
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ formId, answers, headers: readable.headers || [], values: readable.values || [] }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '送信に失敗しました');
    return data;
  },

  // 公開モードでは「すべて削除」は使わない（消すときは選んで削除する）
  async deleteResponses() {
    throw new Error('スプレッドシートの行を削除してください');
  },

  // 指定した回答だけを削除（合言葉が必要。スプレッドシートの該当行が消える）
  async deleteResponseIds(formId, ids) {
    const key = getAdminKey();
    if (!key) throw new AuthError();
    const res = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'delete', key, formId, ids }),
    });
    const data = await res.json();
    if (!data.ok) {
      if (data.error === 'unauthorized') throw new AuthError();
      // 古い Code.gs のままだと削除の命令を知らないので bad_request が返る
      if (data.error === 'bad_request') throw new Error('old_script');
      throw new Error(data.error || '削除に失敗しました');
    }
    return data.deleted;
  },
};

const Store = REMOTE ? RemoteStore : LocalStore;

/* =========================================================
 * 定数・ユーティリティ
 * ========================================================= */

// 質問タイプ
const QUESTION_TYPES = [
  { value: 'short', label: '記述式' },
  { value: 'paragraph', label: '段落' },
  { value: 'radio', label: 'ラジオボタン' },
  { value: 'checkbox', label: 'チェックボックス' },
  { value: 'dropdown', label: 'プルダウン' },
  { value: 'date', label: '日付選択（なぞって選ぶ）' },
];
const CHOICE_TYPES = ['radio', 'checkbox', 'dropdown'];
const DEFAULT_MESSAGE = '回答を記録しました。';

const app = document.getElementById('app');
const $ = (sel, root = document) => root.querySelector(sel);

// HTMLエスケープ（ユーザー入力を innerHTML に入れるときは必ず通す）
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// タイトル用：空白で区切ったかたまりごとに改行させる（「追いコン」が途中で切れないように）
function titleHTML(s) {
  return String(s == null ? '' : s)
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `<span class="title-chunk">${esc(part)}</span>`)
    .join(' ');
}

// ランダムなID
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 今日から offset 日後の 'YYYY-MM-DD'
function todayISO(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return DatePicker.toISO(d);
}

// タイムスタンプ → '2026/11/19 14:05'
function formatDateTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 未回答かどうか
function isEmpty(v) {
  return v == null || v === '' || (Array.isArray(v) && v.length === 0);
}

// 連続した日付をまとめる ['11-19','11-20','11-23'] → [{start:'11-19',end:'11-20'},{start:'11-23',end:'11-23'}]
function compressDates(dates) {
  const runs = [];
  [...dates].sort().forEach((d) => {
    const last = runs[runs.length - 1];
    const next = last && DatePicker.parseISO(last.end);
    if (next) next.setDate(next.getDate() + 1);
    if (last && DatePicker.toISO(next) === d) last.end = d;
    else runs.push({ start: d, end: d });
  });
  return runs;
}

// 日付の配列を読みやすい文字列に '11/19(木)〜11/20(金)、11/23(月)'
function formatDateRanges(dates) {
  const f = DatePicker.formatShort;
  return compressDates(dates)
    .map((r) => (r.start === r.end ? f(r.start) : `${f(r.start)}〜${f(r.end)}`))
    .join('、');
}

// テキストエリアを内容に合わせて伸ばす
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}
document.addEventListener('input', (e) => {
  if (e.target.classList && e.target.classList.contains('autosize')) autoResize(e.target);
});

// 画面下の通知
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// 回答用URL（公開モードではトップページを開くだけで回答画面になる）
function answerUrl(id) {
  const base = location.href.split('#')[0];
  return REMOTE ? base : base + '#/view/' + id;
}

// クリップボードにコピー（使えない環境ではダイアログで表示）
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('回答用のリンクをコピーしました');
  } catch (e) {
    window.prompt('このリンクをコピーしてください', text);
  }
}

/* =========================================================
 * フォームのデータ操作
 * ========================================================= */

function newQuestion(type = 'radio') {
  return {
    id: uid(),
    type,
    title: '',
    description: '',
    required: false,
    placeholder: '',            // 記述式・段落の回答欄に薄く出す例文
    options: ['選択肢 1'],      // 選択式で使う
    branching: false,           // ラジオ：回答に応じて移動するか
    goTo: ['next'],             // ラジオ：選択肢ごとの移動先
    endMsg: [''],               // ラジオ：選択肢ごとの送信後メッセージ
    dateStart: todayISO(0),     // 日付選択で使う
    dateEnd: todayISO(13),
  };
}

function newPage() {
  return { id: uid(), title: '', description: '', next: 'next', questions: [] };
}

function newForm() {
  const now = Date.now();
  const page = newPage();
  page.questions.push(newQuestion());
  return {
    id: uid(),
    title: '無題のフォーム',
    description: '',
    confirmationMessage: DEFAULT_MESSAGE,
    pages: [page],
    acceptingResponses: true,
    createdAt: now,
    updatedAt: now,
  };
}

// 古い形式（pages がない）や項目の足りないデータを、いまの形にそろえる
function normalizeForm(f) {
  if (!f) return f;
  if (!Array.isArray(f.pages)) {
    f.pages = [Object.assign(newPage(), { questions: f.questions || [] })];
    delete f.questions;
  }
  if (f.confirmationMessage == null) f.confirmationMessage = DEFAULT_MESSAGE;
  f.pages.forEach((p) => {
    if (p.title == null) p.title = '';
    if (p.description == null) p.description = '';
    if (!p.next) p.next = 'next';
    p.questions.forEach((q) => {
      if (q.description == null) q.description = '';
      if (q.placeholder == null) q.placeholder = '';
      q.branching = !!q.branching;
      if (!Array.isArray(q.options)) q.options = ['選択肢 1'];
      q.goTo = q.options.map((_, k) => (q.goTo && q.goTo[k]) || 'next');
      q.endMsg = q.options.map((_, k) => (q.endMsg && q.endMsg[k]) || '');
    });
  });
  return f;
}

// 全ページの質問を1列に
function allQuestions(form) {
  return form.pages.flatMap((p) => p.questions);
}

// 選択肢の追加・削除（移動先・メッセージの並びも一緒に動かす）
function insertOption(q, k, label) {
  q.options.splice(k, 0, label);
  q.goTo.splice(k, 0, 'next');
  q.endMsg.splice(k, 0, '');
}
function removeOption(q, k) {
  q.options.splice(k, 1);
  q.goTo.splice(k, 1);
  q.endMsg.splice(k, 1);
}

// 移動先の表示名
function targetLabel(form, value) {
  if (value === 'next') return '次のページへ';
  if (value === 'submit') return 'アンケートを終了して送信';
  const i = form.pages.findIndex((p) => p.id === value);
  if (i < 0) return '次のページへ';
  const t = form.pages[i].title;
  return `${i + 1}ページ目へ${t ? `（${t}）` : ''}`;
}

// 移動先プルダウンの <option> 群
function targetOptionsHTML(form, selected) {
  const values = ['next', ...form.pages.map((p) => p.id), 'submit'];
  return values
    .map((v) => `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(targetLabel(form, v))}</option>`)
    .join('');
}

// 移動先をページ番号に変換する（-1 = 送信）
function resolveTarget(form, pageIndex, target) {
  const nextIndex = pageIndex + 1 < form.pages.length ? pageIndex + 1 : -1;
  if (target === 'submit') return -1;
  if (!target || target === 'next') return nextIndex;
  const i = form.pages.findIndex((p) => p.id === target);
  return i >= 0 ? i : nextIndex;
}

// 回答者の名前に使う質問（タイトルに「名前」「氏名」を含む記述式。なければ最初の記述式）
function nameQuestion(form) {
  const shorts = allQuestions(form).filter((q) => q.type === 'short');
  return shorts.find((q) => /名前|氏名|フルネーム/.test(q.title)) || shorts[0] || null;
}

/* =========================================================
 * サンプルフォーム
 * ========================================================= */

// 追いコン（config.js の OIKON の内容で作る）
// fixedIds = true のときはIDを固定する（公開モード：回答とフォームの対応がずれないように）
function oikonForm(fixedIds = false) {
  const f = newForm();
  f.title = OIKON.title;
  f.description = OIKON.description;
  f.confirmationMessage = OIKON.messageJoin;

  const page1 = f.pages[0];
  const page2 = Object.assign(newPage(), { title: '参加日程について', next: 'submit' });
  f.pages.push(page2);
  if (fixedIds) {
    f.id = PUBLIC_FORM_ID;
    page1.id = 'p1';
    page2.id = 'p2';
  }

  // fixedIds のときは質問IDも固定（name / join / dates / request）
  const q = (id, type, title, extra) => Object.assign(newQuestion(type), fixedIds ? { id } : {}, { title }, extra);
  page1.questions = [
    q('name', 'short', 'フルネーム', { required: true, placeholder: '例：明治 太郎' }),
    q('join', 'radio', '追いコンに参加を希望しますか？', {
      required: true,
      branching: true,
      options: ['参加を希望する', '参加を希望しない'],
      goTo: [page2.id, 'submit'],
      endMsg: [OIKON.messageJoin, OIKON.messageDecline],
    }),
  ];
  page2.questions = [
    q('dates', 'date', '参加できる日を選んでください', {
      required: true,
      description: '参加できる日をすべて選んでください。押したまま横になぞると、まとめて選べます。',
      dateStart: OIKON.dateStart,
      dateEnd: OIKON.dateEnd,
    }),
    q('request', 'paragraph', 'ご要望・ご意見', {
      description: 'お店の希望、苦手な食べ物、その他なんでもどうぞ',
    }),
  ];
  return normalizeForm(f);
}

// ページ分岐の動作確認用
function branchTestForm() {
  const f = newForm();
  f.title = 'ページ分岐のテスト';
  f.description = '選んだ答えによって次のページが変わります。';
  f.confirmationMessage = 'テストの回答を記録しました。';
  const pageA = Object.assign(newPage(), { title: 'Aのページ', next: 'submit' });
  const pageB = Object.assign(newPage(), { title: 'Bのページ', next: 'submit' });
  f.pages.push(pageA, pageB);

  const q = (type, title, extra) => Object.assign(newQuestion(type), { title }, extra);
  f.pages[0].questions = [
    q('short', 'お名前', { required: true }),
    q('radio', 'どこへ進みますか？', {
      required: true,
      branching: true,
      options: ['Aのページへ', 'Bのページへ', 'ここで送信する'],
      goTo: [pageA.id, pageB.id, 'submit'],
      endMsg: ['', '', '1ページ目だけで送信しました。'],
    }),
  ];
  pageA.questions = [q('paragraph', 'Aを選んだ理由', { required: true })];
  pageB.questions = [q('date', 'Bを選んだ人：都合のよい日', { required: true })];
  return normalizeForm(f);
}

// 日程調整（1ページ）
function sampleForm() {
  const f = newForm();
  f.title = '忘年会の日程調整';
  f.description = '参加できる日を教えてください。\n日付は丸を押したままなぞると、まとめて選べます。';
  const q = (type, title, extra) => Object.assign(newQuestion(type), { title }, extra);
  f.pages[0].questions = [
    q('short', 'お名前', { required: true }),
    q('date', '参加できる日', { required: true, dateStart: todayISO(7), dateEnd: todayISO(27) }),
    q('radio', '参加形式', { required: true, options: ['会場で参加', 'オンラインで参加', '未定'] }),
    q('checkbox', '食べたいもの', { options: ['和食', '中華', 'イタリアン', '焼肉'] }),
    q('dropdown', '所属', { options: ['営業部', '開発部', '総務部', 'その他'] }),
    q('paragraph', 'その他ご要望'),
  ];
  return normalizeForm(f);
}

// 初回起動時に追いコンのフォームを作っておく（1回だけ）
async function seedSamples() {
  const FLAG = 'survey.seeded.oikon';
  if (REMOTE) return; // 公開モードではフォームは config.js から作るので不要
  try {
    if (localStorage.getItem(FLAG)) return;
    await Store.saveForm(oikonForm());
    localStorage.setItem(FLAG, '1');
  } catch (e) {
    console.warn('サンプルの作成に失敗しました', e);
  }
}

/* =========================================================
 * ルーター
 * ========================================================= */

let leaveHandler = null; // 画面を離れるときの処理（未保存の内容を確定するなど）
let lastDone = null;     // 直前に送信した回答の完了メッセージ { formId, message }

async function router() {
  if (leaveHandler) {
    leaveHandler();
    leaveHandler = null;
  }
  window.onbeforeunload = null;
  $('#toast').classList.remove('show'); // 前の画面の通知を消す

  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  const [page, id] = path.split('/').filter(Boolean);
  window.scrollTo(0, 0);

  try {
    // 公開モード：回答者には回答画面だけを見せる（結果画面は合言葉が必要）
    if (REMOTE) {
      if (page === 'results') return await renderResults(PUBLIC_FORM_ID);
      if (page === 'done') return await renderDone(PUBLIC_FORM_ID);
      return await renderAnswer(PUBLIC_FORM_ID, false);
    }
    switch (page) {
      case 'edit': return await renderEditor(id);
      case 'view': return await renderAnswer(id, new URLSearchParams(query).has('preview'));
      case 'done': return await renderDone(id);
      case 'results': return await renderResults(id);
      default: return await renderHome();
    }
  } catch (err) {
    console.error(err);
    app.innerHTML = `<main class="container narrow"><section class="card"><p>エラーが発生しました。</p><a href="#/">一覧へ戻る</a></section></main>`;
  }
}

async function loadForm(id) {
  return normalizeForm(await Store.getForm(id));
}

function renderNotFound() {
  document.title = 'フォームが見つかりません';
  app.innerHTML = `
    <main class="container narrow">
      <section class="card head-card">
        <h1 class="view-title">フォームが見つかりません</h1>
        <p>削除されたか、URLが間違っている可能性があります。</p>
        <a class="link-btn" href="#/">フォーム一覧へ</a>
      </section>
    </main>`;
}

/* =========================================================
 * フォーム一覧画面
 * ========================================================= */

const TEMPLATES = [
  { key: 'blank', icon: '＋', label: '空白のフォーム', make: newForm },
  { key: 'oikon', icon: '🎓', label: '追いコンのご案内', make: oikonForm },
  { key: 'branch', icon: '🔀', label: 'ページ分岐のテスト', make: branchTestForm },
  { key: 'sample', icon: '📅', label: '日程調整（1ページ）', make: sampleForm },
];

async function renderHome() {
  document.title = 'アンケート';
  const forms = (await Store.listForms()).sort((a, b) => b.updatedAt - a.updatedAt);
  const counts = await Promise.all(forms.map((f) => Store.listResponses(f.id).then((r) => r.length)));

  app.innerHTML = `
    <header class="topbar">
      <div class="brand"><span class="brand-icon" aria-hidden="true">≡</span>アンケート</div>
    </header>
    <section class="home-new">
      <div class="container">
        <h2 class="section-title">新しいフォームを作成</h2>
        <div class="template-row">
          ${TEMPLATES.map((t) => `
            <button type="button" class="template" data-key="${t.key}">
              <span class="template-thumb">${t.icon}</span><span>${t.label}</span>
            </button>`).join('')}
        </div>
      </div>
    </section>
    <main class="container">
      <h2 class="section-title">最近のフォーム</h2>
      ${forms.length ? `<div class="form-list">${forms.map((f, i) => `
        <div class="card form-item" data-id="${f.id}">
          <div class="form-item-main">
            <div class="form-item-title">${esc(f.title || '無題のフォーム')}</div>
            <div class="form-item-meta">回答 ${counts[i]} 件 ・ 更新 ${formatDateTime(f.updatedAt)}</div>
          </div>
          <div class="form-item-actions">
            <a class="link-btn" href="#/edit/${f.id}">編集</a>
            <a class="link-btn" href="#/view/${f.id}">回答する</a>
            <a class="link-btn" href="#/results/${f.id}">結果</a>
            <button type="button" class="link-btn danger" data-act="delete">削除</button>
          </div>
        </div>`).join('')}</div>`
        : '<p class="empty">まだフォームがありません。上から作成してください。</p>'}
    </main>`;

  // 新規作成
  app.querySelectorAll('.template').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const form = TEMPLATES.find((t) => t.key === btn.dataset.key).make();
      await Store.saveForm(form);
      location.hash = `#/edit/${form.id}`;
    });
  });

  // 削除
  app.querySelectorAll('[data-act="delete"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('.form-item').dataset.id;
      const form = forms.find((f) => f.id === id);
      if (!confirm(`「${form.title || '無題のフォーム'}」を削除しますか？\n回答もすべて削除されます。`)) return;
      await Store.deleteForm(id);
      renderHome();
    });
  });
}

/* =========================================================
 * 作成画面・結果画面の共通ヘッダー
 * ========================================================= */

function editorHeader(form, tab, count) {
  return `
    <header class="topbar">
      <a href="#/" class="icon-btn" title="フォーム一覧へ" aria-label="フォーム一覧へ">←</a>
      <div class="topbar-title">${esc(form.title || '無題のフォーム')}</div>
      <span class="save-status" id="saveStatus"></span>
      <a class="icon-btn" href="#/view/${form.id}?preview" title="プレビュー" aria-label="プレビュー">👁</a>
      <button type="button" class="btn primary" id="copyLink">リンクをコピー</button>
    </header>
    <nav class="tabs">
      <a href="#/edit/${form.id}" class="tab ${tab === 'edit' ? 'active' : ''}">質問</a>
      <a href="#/results/${form.id}" class="tab ${tab === 'results' ? 'active' : ''}">回答${count ? `<span class="badge">${count}</span>` : ''}</a>
    </nav>`;
}

function setupHeader(form) {
  $('#copyLink').addEventListener('click', () => copyText(answerUrl(form.id)));
}

/* =========================================================
 * 作成（編集）画面
 * ========================================================= */

async function renderEditor(id) {
  const form = await loadForm(id);
  if (!form) return renderNotFound();
  const count = (await Store.listResponses(id)).length;
  document.title = `${form.title || '無題のフォーム'} - 編集`;

  app.innerHTML = `
    ${editorHeader(form, 'edit', count)}
    <main class="container narrow editor">
      <div id="pages"></div>
      <button type="button" class="add-page" data-act="add-page">＋ ページを追加</button>
      <section class="card settings-card">
        <h3 class="settings-title">送信後に表示するメッセージ</h3>
        <textarea class="settings-msg autosize" data-form-field="confirmationMessage" rows="2" aria-label="送信後に表示するメッセージ">${esc(form.confirmationMessage)}</textarea>
        <p class="hint">ラジオボタンの「回答に応じて移動」で選択肢ごとのメッセージを入れた場合は、そちらが優先されます。</p>
      </section>
    </main>`;
  setupHeader(form);

  const main = $('.editor');
  const pagesEl = $('#pages');

  /* ---------- 自動保存（入力が止まって0.4秒後に保存） ---------- */
  const status = $('#saveStatus');
  let timer = null;
  const flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    form.updatedAt = Date.now();
    Store.saveForm(form);
    status.textContent = '変更内容をすべて保存しました';
  };
  const save = () => {
    status.textContent = '保存中…';
    clearTimeout(timer);
    timer = setTimeout(flush, 400);
  };
  leaveHandler = flush;          // 別の画面へ移るときに確定
  window.onbeforeunload = flush; // タブを閉じるときも確定

  let activeId = null; // 最後に操作した質問（「質問を追加」はその下に入る）

  /* ---------- 描画 ---------- */
  function render(focusSel) {
    pagesEl.innerHTML = form.pages.map((p, pi) => pageEditorHTML(form, p, pi)).join('');
    allQuestions(form).forEach((q) => {
      if (q.type !== 'date') return;
      const box = pagesEl.querySelector(`[data-qid="${q.id}"] .dp-preview`);
      if (box) new DatePicker(box, { start: q.dateStart, end: q.dateEnd });
    });
    main.querySelectorAll('.autosize').forEach(autoResize);
    if (focusSel) {
      const el = pagesEl.querySelector(focusSel);
      if (el) {
        el.focus({ preventScroll: true });
        if (el.select) el.select();
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }

  // ページ名を変えたら、移動先プルダウンの表示名も更新する
  function refreshTargetLabels() {
    pagesEl.querySelectorAll('select[data-target] option').forEach((o) => {
      o.textContent = targetLabel(form, o.value);
    });
  }

  /* ---------- 要素 → データの対応 ---------- */
  const pageOf = (el) => {
    const block = el.closest('.page-block');
    return block ? form.pages.find((p) => p.id === block.dataset.pid) : null;
  };
  const questionOf = (el) => {
    const card = el.closest('.q-card');
    return card ? allQuestions(form).find((q) => q.id === card.dataset.qid) : null;
  };
  const locate = (q) => {
    const pi = form.pages.findIndex((p) => p.questions.includes(q));
    return { pi, qi: form.pages[pi].questions.indexOf(q) };
  };

  main.addEventListener('focusin', (e) => {
    const q = questionOf(e.target);
    if (q) activeId = q.id;
  });

  /* ---------- 文字入力 ---------- */
  main.addEventListener('input', (e) => {
    const t = e.target;
    const d = t.dataset;
    if (d.formField) {
      form[d.formField] = t.value;
      if (d.formField === 'title') $('.topbar-title').textContent = form.title || '無題のフォーム';
      return save();
    }
    if (d.pageField && t.tagName !== 'SELECT') {
      pageOf(t)[d.pageField] = t.value;
      return save();
    }
    const q = questionOf(t);
    if (!q) return;
    if (['title', 'description', 'placeholder'].includes(d.field)) q[d.field] = t.value;
    else if (d.opt != null) q.options[Number(d.opt)] = t.value;
    else if (d.msg != null) q.endMsg[Number(d.msg)] = t.value;
    else return;
    save();
  });

  /* ---------- 選択・切り替え ---------- */
  main.addEventListener('change', (e) => {
    const t = e.target;
    const d = t.dataset;
    if (d.pageField === 'title') return refreshTargetLabels();
    if (d.pageField === 'next') {
      pageOf(t).next = t.value;
      return save();
    }
    const q = questionOf(t);
    if (!q) return;
    if (d.field === 'type') {
      q.type = t.value;
      if (CHOICE_TYPES.includes(q.type) && q.options.length === 0) insertOption(q, 0, '選択肢 1');
      render(`[data-qid="${q.id}"] .q-type`);
    } else if (d.field === 'required') {
      q.required = t.checked;
    } else if (d.field === 'branching') {
      q.branching = t.checked;
      render();
    } else if (d.goto != null) {
      q.goTo[Number(d.goto)] = t.value;
    } else if (d.field === 'dateStart' || d.field === 'dateEnd') {
      q[d.field] = t.value;
      // 開始日 > 終了日 なら入れ替える
      if (q.dateStart && q.dateEnd && q.dateStart > q.dateEnd) [q.dateStart, q.dateEnd] = [q.dateEnd, q.dateStart];
      // 長すぎる範囲は上限（366日）で切る
      const days = DatePicker.listDates(q.dateStart, q.dateEnd);
      if (days.length && days[days.length - 1] !== q.dateEnd) {
        q.dateEnd = days[days.length - 1];
        toast('日付の範囲は最大366日です');
      }
      render();
    } else {
      return;
    }
    save();
  });

  /* ---------- ボタン操作 ---------- */
  main.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;

    // ページ単位の操作
    if (act === 'add-page') {
      const p = newPage();
      form.pages.push(p);
      render(`[data-pid="${p.id}"] .page-title`);
      return save();
    }
    if (act === 'del-page') {
      const p = pageOf(btn);
      const pi = form.pages.indexOf(p);
      if (pi <= 0) return;
      if (p.questions.length && !confirm('このページを削除しますか？\nページ内の質問は前のページに移動します。')) return;
      form.pages[pi - 1].questions.push(...p.questions);
      form.pages.splice(pi, 1);
      // 削除したページを移動先にしていた設定は「次のページへ」に戻す
      form.pages.forEach((pg) => {
        if (pg.next === p.id) pg.next = 'next';
        pg.questions.forEach((q) => {
          q.goTo = q.goTo.map((g) => (g === p.id ? 'next' : g));
        });
      });
      render();
      toast('ページを削除しました');
      return save();
    }
    if (act === 'add-q') {
      const p = pageOf(btn);
      const q = newQuestion();
      const idx = p.questions.findIndex((x) => x.id === activeId);
      p.questions.splice(idx >= 0 ? idx + 1 : p.questions.length, 0, q);
      activeId = q.id;
      render(`[data-qid="${q.id}"] .q-title`);
      return save();
    }

    // 質問単位の操作
    const q = questionOf(btn);
    if (!q) return;
    const { pi, qi } = locate(q);
    const qs = form.pages[pi].questions;
    const sel = (s) => `[data-qid="${q.id}"] ${s}`;

    switch (act) {
      case 'up':
        // ページの先頭なら前のページの末尾へ移る
        if (qi > 0) [qs[qi - 1], qs[qi]] = [qs[qi], qs[qi - 1]];
        else if (pi > 0) form.pages[pi - 1].questions.push(qs.splice(qi, 1)[0]);
        render(sel('[data-act="up"]'));
        break;
      case 'down':
        // ページの末尾なら次のページの先頭へ移る
        if (qi < qs.length - 1) [qs[qi + 1], qs[qi]] = [qs[qi], qs[qi + 1]];
        else if (pi < form.pages.length - 1) form.pages[pi + 1].questions.unshift(qs.splice(qi, 1)[0]);
        render(sel('[data-act="down"]'));
        break;
      case 'dup': {
        const copy = Object.assign(JSON.parse(JSON.stringify(q)), { id: uid() });
        qs.splice(qi + 1, 0, copy);
        activeId = copy.id;
        render(`[data-qid="${copy.id}"] .q-title`);
        break;
      }
      case 'del':
        qs.splice(qi, 1);
        render();
        toast('質問を削除しました');
        break;
      case 'add-opt':
        insertOption(q, q.options.length, `選択肢 ${q.options.length + 1}`);
        render(sel(`[data-opt="${q.options.length - 1}"]`));
        break;
      case 'del-opt':
        if (q.options.length > 1) removeOption(q, Number(btn.dataset.k));
        render();
        break;
      default:
        return;
    }
    save();
  });

  // 選択肢で Enter → 次の選択肢を追加（日本語変換中の Enter は無視）
  main.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.target.dataset.opt == null) return;
    e.preventDefault();
    const q = questionOf(e.target);
    const k = Number(e.target.dataset.opt);
    insertOption(q, k + 1, `選択肢 ${q.options.length + 1}`);
    render(`[data-qid="${q.id}"] [data-opt="${k + 1}"]`);
    save();
  });

  render();
}

// ページ1つ分（見出し＋質問＋ページ末尾の設定）のHTML
function pageEditorHTML(form, page, pi) {
  const n = form.pages.length;
  const header = pi === 0
    ? `<section class="card head-card">
        <input class="head-title" data-form-field="title" value="${esc(form.title)}" placeholder="フォームのタイトル" aria-label="フォームのタイトル">
        <textarea class="head-desc autosize" data-form-field="description" rows="1" placeholder="フォームの説明" aria-label="フォームの説明">${esc(form.description)}</textarea>
      </section>`
    : `<section class="card head-card page-card">
        <div class="page-card-top">
          <input class="page-title" data-page-field="title" value="${esc(page.title)}" placeholder="ページのタイトル（任意）" aria-label="ページのタイトル">
          <button type="button" class="icon-btn" data-act="del-page" title="ページを削除" aria-label="ページを削除">🗑</button>
        </div>
        <textarea class="head-desc autosize" data-page-field="description" rows="1" placeholder="説明（任意）" aria-label="ページの説明">${esc(page.description)}</textarea>
      </section>`;

  const questions = page.questions.map((q, qi) => questionEditorHTML(form, q, {
    first: pi === 0 && qi === 0,
    last: pi === n - 1 && qi === page.questions.length - 1,
  })).join('');

  let after = '';
  if (n > 1) {
    after = pi < n - 1
      ? `<label class="page-next">このページの後：
          <select data-page-field="next" data-target>${targetOptionsHTML(form, page.next)}</select>
        </label>`
      : '<p class="page-next">最後のページ（「送信」ボタンが表示されます）</p>';
  }

  return `
    <div class="page-block" data-pid="${page.id}">
      ${n > 1 ? `<div class="page-tag">ページ ${pi + 1} / ${n}</div>` : ''}
      ${header}
      ${questions || '<p class="page-empty">このページにはまだ質問がありません</p>'}
      <div class="page-foot">
        <button type="button" class="add-question" data-act="add-q">＋ このページに質問を追加</button>
        ${after}
      </div>
    </div>`;
}

// 質問カード（編集用）のHTML
function questionEditorHTML(form, q, pos) {
  const typeOptions = QUESTION_TYPES
    .map((t) => `<option value="${t.value}" ${t.value === q.type ? 'selected' : ''}>${t.label}</option>`)
    .join('');
  return `
    <section class="card q-card" data-qid="${q.id}">
      <div class="q-top">
        <textarea class="q-title autosize" data-field="title" rows="1" placeholder="質問" aria-label="質問文">${esc(q.title)}</textarea>
        <select class="q-type" data-field="type" aria-label="質問の種類">${typeOptions}</select>
      </div>
      <textarea class="q-desc autosize" data-field="description" rows="1" placeholder="説明（任意）" aria-label="質問の説明">${esc(q.description)}</textarea>
      <div class="q-body">${questionBodyEditorHTML(form, q)}</div>
      <div class="q-footer">
        <button type="button" class="icon-btn" data-act="up" title="上へ移動" aria-label="上へ移動" ${pos.first ? 'disabled' : ''}>↑</button>
        <button type="button" class="icon-btn" data-act="down" title="下へ移動" aria-label="下へ移動" ${pos.last ? 'disabled' : ''}>↓</button>
        <span class="spacer"></span>
        <button type="button" class="icon-btn" data-act="dup" title="複製" aria-label="複製">⧉</button>
        <button type="button" class="icon-btn" data-act="del" title="削除" aria-label="削除">🗑</button>
        <span class="divider"></span>
        ${q.type === 'radio' ? `
          <label class="switch">
            <span>回答に応じて移動</span>
            <input type="checkbox" data-field="branching" ${q.branching ? 'checked' : ''}>
            <span class="switch-ui"></span>
          </label>
          <span class="divider"></span>` : ''}
        <label class="switch">
          <span>必須</span>
          <input type="checkbox" data-field="required" ${q.required ? 'checked' : ''}>
          <span class="switch-ui"></span>
        </label>
      </div>
    </section>`;
}

// 質問タイプごとの編集欄
function questionBodyEditorHTML(form, q) {
  switch (q.type) {
    case 'short':
    case 'paragraph':
      return `
        <input class="placeholder-input ${q.type === 'paragraph' ? 'long' : ''}" data-field="placeholder" value="${esc(q.placeholder)}"
          placeholder="${q.type === 'short' ? '記述式テキスト（短文回答）' : '記述式テキスト（長文回答）'}" aria-label="回答欄の例文">
        <p class="hint small">↑ 回答欄に薄く表示する例文を入れられます（任意）</p>`;
    case 'date': {
      const days = DatePicker.listDates(q.dateStart, q.dateEnd).length;
      return `
        <div class="date-config">
          <label>開始日 <input type="date" data-field="dateStart" value="${esc(q.dateStart)}"></label>
          <span aria-hidden="true">〜</span>
          <label>終了日 <input type="date" data-field="dateEnd" value="${esc(q.dateEnd)}"></label>
          <span class="date-count">${days ? `${days}日間` : ''}</span>
        </div>
        <p class="hint">回答者は丸ボタンを押したままなぞって日付を選びます。下はプレビューです（試しに操作できますが保存はされません）。</p>
        <div class="dp-preview"></div>`;
    }
    default: {
      // ラジオ・チェックボックス・プルダウン
      const branch = q.type === 'radio' && q.branching;
      const marker = (k) => (q.type === 'radio' ? '<span class="mark radio"></span>'
        : q.type === 'checkbox' ? '<span class="mark checkbox"></span>'
          : `<span class="mark num">${k + 1}.</span>`);
      return `
        <div class="opt-list">
          ${q.options.map((o, k) => `
            <div class="opt-item ${branch ? 'branch' : ''}">
              <div class="opt-row">
                ${marker(k)}
                <input class="opt-input" data-opt="${k}" value="${esc(o)}" aria-label="選択肢${k + 1}">
                ${q.options.length > 1 ? `<button type="button" class="icon-btn small" data-act="del-opt" data-k="${k}" title="選択肢を削除" aria-label="選択肢を削除">✕</button>` : ''}
              </div>
              ${branch ? `
                <div class="opt-branch">
                  <label>回答後の移動先
                    <select class="goto-select" data-goto="${k}" data-target>${targetOptionsHTML(form, q.goTo[k])}</select>
                  </label>
                  <input class="opt-msg" data-msg="${k}" value="${esc(q.endMsg[k])}" placeholder="この選択肢で送信した人へのメッセージ（任意）" aria-label="送信後のメッセージ">
                </div>` : ''}
            </div>`).join('')}
          <div class="opt-row">
            ${marker(q.options.length)}
            <button type="button" class="link-btn" data-act="add-opt">選択肢を追加</button>
          </div>
        </div>`;
    }
  }
}

/* =========================================================
 * 回答画面（1ページずつ表示）
 * ========================================================= */

async function renderAnswer(id, isPreview) {
  const form = await loadForm(id);
  if (!form) return renderNotFound();
  document.title = form.title || '無題のフォーム';
  const pages = form.pages;
  const multi = pages.length > 1;

  const banner = isPreview
    ? `<div class="preview-bar">プレビュー表示中（送信すると実際に回答として記録されます）<a href="#/edit/${id}">編集に戻る</a></div>`
    : '';

  // 回答受付を停止している場合
  if (form.acceptingResponses === false) {
    app.innerHTML = `${banner}
      <main class="container narrow answer">
        <section class="card head-card">
          <h1 class="view-title">${titleHTML(form.title || '無題のフォーム')}</h1>
          <p>このフォームは現在、回答を受け付けていません。</p>
        </section>
      </main>`;
    return;
  }

  app.innerHTML = `${banner}
    ${multi ? `
      <div class="progress" role="progressbar" aria-valuemin="1" aria-valuemax="${pages.length}">
        <div class="progress-inner">
          <div class="progress-bar"><div class="progress-fill"></div></div>
          <span class="progress-text"></span>
        </div>
      </div>` : ''}
    <main class="container narrow answer">
      <section class="card head-card">
        <h1 class="view-title">${titleHTML(form.title || '無題のフォーム')}</h1>
        <div class="head-extra">
          ${form.description ? `<p class="view-desc">${esc(form.description)}</p>` : ''}
          ${allQuestions(form).some((q) => q.required) ? '<p class="req-note"><span class="req">*</span> 必須の質問です</p>' : ''}
        </div>
      </section>
      <form id="answerForm" novalidate>
        ${pages.map((p, pi) => `
          <div class="a-page" data-page="${pi}" ${pi === 0 ? '' : 'hidden'}>
            ${pi > 0 && (p.title || p.description) ? `
              <section class="card page-head">
                ${p.title ? `<h2 class="page-head-title">${esc(p.title)}</h2>` : ''}
                ${p.description ? `<p class="view-desc">${esc(p.description)}</p>` : ''}
              </section>` : ''}
            ${p.questions.map(answerQuestionHTML).join('')}
          </div>`).join('')}
        <div class="form-actions">
          <div class="nav-btns">
            <button type="button" class="btn" id="backBtn" hidden>戻る</button>
            <button type="submit" class="btn primary" id="nextBtn">送信</button>
          </div>
          <button type="button" class="link-btn" id="clearForm">フォームをクリア</button>
        </div>
      </form>
    </main>`;

  const formEl = $('#answerForm');
  const nextBtn = $('#nextBtn');
  const backBtn = $('#backBtn');
  const cardOf = (q) => formEl.querySelector(`[data-qid="${q.id}"]`);

  let current = 0;     // いま表示しているページ
  const history = [];  // 通ってきたページ（「戻る」用）

  /* ---------- エラー表示 ---------- */
  const setError = (card) => {
    card.classList.add('has-error');
    card.querySelector('.a-error').hidden = false;
  };
  const clearError = (card) => {
    card.classList.remove('has-error');
    card.querySelector('.a-error').hidden = true;
  };

  /* ---------- 日付選択 ---------- */
  const dateValues = {};
  const pickers = {};
  allQuestions(form).filter((q) => q.type === 'date').forEach((q) => {
    const card = cardOf(q);
    const summary = card.querySelector('.date-summary');
    dateValues[q.id] = [];
    pickers[q.id] = new DatePicker(card.querySelector('.dp-mount'), {
      start: q.dateStart,
      end: q.dateEnd,
      onChange: (dates) => {
        dateValues[q.id] = dates;
        summary.textContent = dates.length ? `選択中：${formatDateRanges(dates)}（${dates.length}日）` : '選択なし';
        if (dates.length) clearError(card);
      },
    });
  });

  // 質問ごとの回答を読み取る
  function readAnswer(q) {
    const name = `q_${q.id}`;
    switch (q.type) {
      case 'short':
      case 'paragraph':
        return formEl.elements[name].value.trim();
      case 'radio': {
        const c = formEl.querySelector(`input[name="${name}"]:checked`);
        return c ? c.value : '';
      }
      case 'dropdown':
        return formEl.elements[name].value;
      case 'checkbox':
        return [...formEl.querySelectorAll(`input[name="${name}"]:checked`)].map((c) => c.value);
      case 'date':
        return dateValues[q.id] || [];
      default:
        return '';
    }
  }

  /* ---------- ページ移動 ---------- */

  // いまのページの回答から、次に行くページ番号を決める（-1 = 送信）
  function nextTarget() {
    const page = pages[current];
    let target = page.next || 'next';
    page.questions.forEach((q) => {
      if (q.type !== 'radio' || !q.branching) return;
      const k = q.options.indexOf(readAnswer(q));
      if (k >= 0 && q.goTo[k] && q.goTo[k] !== 'next') target = q.goTo[k];
    });
    return resolveTarget(form, current, target);
  }

  // 「次へ」と「送信」の切り替え
  function updateNextButton() {
    nextBtn.textContent = nextTarget() === -1 ? '送信' : '次へ';
  }

  function showPage(i) {
    current = i;
    formEl.querySelectorAll('.a-page').forEach((el) => {
      el.hidden = Number(el.dataset.page) !== i;
    });
    $('.head-extra').hidden = i !== 0; // 説明文は1ページ目だけ
    backBtn.hidden = history.length === 0;
    if (multi) {
      $('.progress-text').textContent = `${i + 1} / ${pages.length}`;
      $('.progress-fill').style.width = `${((i + 1) / pages.length) * 100}%`;
      $('.progress').setAttribute('aria-valuenow', i + 1);
    }
    updateNextButton();
    window.scrollTo(0, 0);
  }

  // いまのページの必須チェック
  function validatePage(i) {
    let firstError = null;
    pages[i].questions.forEach((q) => {
      if (q.required && isEmpty(readAnswer(q))) {
        setError(cardOf(q));
        if (!firstError) firstError = cardOf(q);
      } else {
        clearError(cardOf(q));
      }
    });
    if (firstError) {
      firstError.scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast('未回答の必須の質問があります');
      return false;
    }
    return true;
  }

  /* ---------- 入力イベント ---------- */
  const onEdit = (e) => {
    const card = e.target.closest('.a-card');
    if (!card) return;
    clearError(card);
    const clearBtn = card.querySelector('.clear-radio');
    if (clearBtn) clearBtn.hidden = !card.querySelector('input[type="radio"]:checked');
    updateNextButton();
  };
  formEl.addEventListener('input', onEdit);
  formEl.addEventListener('change', onEdit);

  // ラジオボタンの選択解除
  formEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.clear-radio');
    if (!btn) return;
    btn.closest('.a-card').querySelectorAll('input[type="radio"]').forEach((r) => { r.checked = false; });
    btn.hidden = true;
    updateNextButton();
  });

  backBtn.addEventListener('click', () => {
    if (history.length) showPage(history.pop());
  });

  /* ---------- 次へ／送信 ---------- */
  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validatePage(current)) return;

    const target = nextTarget();
    if (target !== -1) {
      history.push(current);
      showPage(target);
      return;
    }

    // 送信：通ってきたページの回答だけを記録する
    const visited = [...history, current];
    const answers = {};
    let message = form.confirmationMessage || DEFAULT_MESSAGE;
    visited.forEach((pi) => {
      pages[pi].questions.forEach((q) => {
        const v = readAnswer(q);
        answers[q.id] = v;
        // 分岐の選択肢に送信後メッセージがあればそれを使う（後のページのものが優先）
        if (q.type === 'radio' && q.branching) {
          const k = q.options.indexOf(v);
          if (k >= 0 && q.endMsg[k].trim()) message = q.endMsg[k];
        }
      });
    });
    // スプレッドシートで人が読むための列（質問ごとに1列）
    const qs = allQuestions(form);
    const readable = {
      headers: qs.map((q) => q.title || '無題の質問'),
      values: qs.map((q) => answerToText(q, answers[q.id])),
    };

    nextBtn.disabled = true;
    nextBtn.textContent = '送信中…';
    try {
      await Store.addResponse(form.id, answers, readable);
    } catch (err) {
      console.error(err);
      nextBtn.disabled = false;
      updateNextButton();
      toast('送信に失敗しました。通信環境を確認して、もう一度「送信」を押してください');
      return;
    }
    lastDone = { formId: form.id, message };
    location.hash = `#/done/${form.id}`;
  });

  /* ---------- フォームをクリア ---------- */
  $('#clearForm').addEventListener('click', () => {
    if (!confirm('すべての質問から回答が削除されます。フォームをクリアしますか？')) return;
    formEl.reset();
    Object.keys(pickers).forEach((qid) => {
      pickers[qid].setValue([]);
      dateValues[qid] = [];
    });
    formEl.querySelectorAll('.date-summary').forEach((el) => { el.textContent = '選択なし'; });
    formEl.querySelectorAll('.clear-radio').forEach((el) => { el.hidden = true; });
    formEl.querySelectorAll('.a-card').forEach(clearError);
    formEl.querySelectorAll('.autosize').forEach(autoResize);
    history.length = 0;
    showPage(0);
  });

  showPage(0);
}

// 回答を文字にする（スプレッドシート・CSV用）
function answerToText(q, v) {
  if (isEmpty(v)) return '';
  if (q.type === 'date') return v.map(DatePicker.formatShort).join(', ');
  return Array.isArray(v) ? v.join(', ') : String(v);
}

// 質問カード（回答用）のHTML
function answerQuestionHTML(q) {
  const name = `q_${q.id}`;
  const titleId = `t_${q.id}`;
  let body;
  switch (q.type) {
    case 'short':
      body = `<input type="text" class="a-input" name="${name}" aria-labelledby="${titleId}" placeholder="${esc(q.placeholder || '回答を入力')}">`;
      break;
    case 'paragraph':
      body = `<textarea class="a-input a-textarea autosize" name="${name}" rows="1" aria-labelledby="${titleId}" placeholder="${esc(q.placeholder || '回答を入力')}"></textarea>`;
      break;
    case 'radio':
    case 'checkbox':
      body = `
        <div class="choices" role="${q.type === 'radio' ? 'radiogroup' : 'group'}" aria-labelledby="${titleId}">
          ${q.options.map((o) => `
            <label class="choice">
              <input type="${q.type}" name="${name}" value="${esc(o)}">
              <span>${esc(o)}</span>
            </label>`).join('')}
        </div>
        ${q.type === 'radio' ? '<button type="button" class="link-btn clear-radio" hidden>選択を解除</button>' : ''}`;
      break;
    case 'dropdown':
      body = `
        <select class="a-select" name="${name}" aria-labelledby="${titleId}">
          <option value="">選択</option>
          ${q.options.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
        </select>`;
      break;
    case 'date':
      body = `
        ${q.description ? '' : '<p class="hint">丸を押したままなぞると、まとめて選択できます。選んだ日をタップするとその日だけ解除されます。</p>'}
        <div class="dp-mount"></div>
        <p class="date-summary">選択なし</p>`;
      break;
    default:
      body = '';
  }
  return `
    <section class="card a-card" data-qid="${q.id}">
      <div class="a-title" id="${titleId}">${esc(q.title || '無題の質問')}${q.required ? ' <span class="req">*</span>' : ''}</div>
      ${q.description ? `<p class="a-desc">${esc(q.description)}</p>` : ''}
      <div class="a-body">${body}</div>
      <p class="a-error" hidden>⚠ この質問は必須です</p>
    </section>`;
}

/* =========================================================
 * 送信完了画面
 * ========================================================= */

async function renderDone(id) {
  const form = await loadForm(id);
  if (!form) return renderNotFound();
  document.title = form.title || '無題のフォーム';
  // 回答直後なら分岐に応じたメッセージ、それ以外（再読み込みなど）は既定のメッセージ
  const message = lastDone && lastDone.formId === id
    ? lastDone.message
    : (form.confirmationMessage || DEFAULT_MESSAGE);
  app.innerHTML = `
    <main class="container narrow answer">
      <section class="card head-card">
        <h1 class="view-title">${titleHTML(form.title || '無題のフォーム')}</h1>
        <p class="done-msg">${esc(message)}</p>
        ${REMOTE
          ? `<p class="hint">回答を修正したいときは、もう一度回答してください（同じ名前の場合は最新の回答が使われます）。</p>
             <a class="link-btn" href="#/">もう一度回答する</a>`
          : `<a class="link-btn" href="#/view/${id}">別の回答を送信</a>`}
      </section>
    </main>`;
}

/* =========================================================
 * 結果画面
 * ========================================================= */

// 結果画面のヘッダー（公開モードでは編集タブなどを出さない）
function resultsHeader(form, count) {
  if (!REMOTE) return editorHeader(form, 'results', count);
  return `
    <header class="topbar">
      <div class="topbar-title">${esc(form.title || '無題のフォーム')}（集計）</div>
      <button type="button" class="icon-btn" id="reload" title="最新の回答を読み込む" aria-label="最新の回答を読み込む">⟳</button>
      <button type="button" class="btn primary" id="copyLink">回答用リンクをコピー</button>
    </header>`;
}

// 同じ名前で複数回答した人は、最新の回答だけを残す
function dedupeByName(responses, nameQ) {
  if (!nameQ) return { list: responses, dropped: [] };
  const norm = (s) => String(s || '').replace(/\s+/g, '');
  const latest = new Map();
  responses.forEach((r) => {
    const k = norm(r.answers[nameQ.id]);
    if (!k) return;
    const prev = latest.get(k);
    if (!prev || r.submittedAt >= prev.submittedAt) latest.set(k, r);
  });
  const keep = responses.filter((r) => {
    const k = norm(r.answers[nameQ.id]);
    return !k || latest.get(k) === r;
  });
  return { list: keep, dropped: responses.filter((r) => !keep.includes(r)) };
}

// 合言葉の入力画面（公開モード）
function renderKeyPrompt(id, failed) {
  document.title = '集計結果';
  app.innerHTML = `
    <main class="container narrow">
      <section class="card head-card">
        <h1 class="view-title">集計結果</h1>
        <p>結果を見るには合言葉を入力してください。</p>
        <form id="keyForm" class="key-form">
          <input type="password" class="a-input" id="adminKey" placeholder="合言葉" aria-label="合言葉" autocomplete="current-password" required>
          <button type="submit" class="btn primary">表示</button>
        </form>
        ${failed ? '<p class="a-error">⚠ 合言葉が違います</p>' : ''}
      </section>
    </main>`;
  $('#adminKey').focus();
  $('#keyForm').addEventListener('submit', (e) => {
    e.preventDefault();
    setAdminKey($('#adminKey').value.trim());
    renderResults(id);
  });
}

async function renderResults(id) {
  const form = await loadForm(id);
  if (!form) return renderNotFound();
  document.title = `${form.title || '無題のフォーム'} - 回答`;

  // 回答の読み込み（公開モードでは通信するので「読み込み中」を出す）
  let allResponses;
  if (REMOTE) {
    if (!getAdminKey()) return renderKeyPrompt(id, false);
    app.innerHTML = '<main class="container narrow"><section class="card"><p class="empty">回答を読み込んでいます…</p></section></main>';
    try {
      allResponses = await Store.listResponses(id);
    } catch (err) {
      if (err instanceof AuthError) {
        setAdminKey('');
        return renderKeyPrompt(id, true);
      }
      console.error(err);
      app.innerHTML = `
        <main class="container narrow"><section class="card">
          <p>回答を読み込めませんでした。通信環境と config.js の API_URL を確認してください。</p>
          <button type="button" class="btn" id="retry">もう一度読み込む</button>
        </section></main>`;
      $('#retry').addEventListener('click', () => renderResults(id));
      return;
    }
  } else {
    allResponses = await Store.listResponses(id);
  }

  const accepting = form.acceptingResponses !== false;
  const nameQ = nameQuestion(form);
  const { list: responses, dropped } = dedupeByName(allResponses, nameQ);

  // 回答者の名前（名前の質問がなければ「回答者1」など）
  const names = new Map(responses.map((r, i) => {
    const v = nameQ && r.answers[nameQ.id];
    return [r.id, v || `回答者${i + 1}`];
  }));
  const ctx = { responses, nameQ, nameOf: (r) => names.get(r.id) };

  const dupNames = [...new Set(dropped.map((r) => r.answers[nameQ.id]))];
  const tools = REMOTE
    ? `
      <button type="button" class="btn" id="csv" ${responses.length ? '' : 'disabled'}>CSVダウンロード</button>
      <button type="button" class="link-btn" id="logout">合言葉を消す</button>`
    : `
      <label class="switch">
        <span>回答を受け付ける</span>
        <input type="checkbox" id="accepting" ${accepting ? 'checked' : ''}>
        <span class="switch-ui"></span>
      </label>
      <button type="button" class="btn" id="csv" ${responses.length ? '' : 'disabled'}>CSVダウンロード</button>
      <button type="button" class="btn danger" id="delAll" ${allResponses.length ? '' : 'disabled'}>すべての回答を削除</button>`;

  app.innerHTML = `
    ${resultsHeader(form, responses.length)}
    <main class="container narrow results">
      <section class="card res-head">
        <div class="res-count">${responses.length}人の回答${dropped.length ? `<small>（送信 ${allResponses.length}件）</small>` : ''}</div>
        <div class="res-tools">${tools}</div>
        ${dropped.length ? `
          <p class="res-note">同じ名前で複数回答した人がいたため、最新の回答だけを集計しています（${dupNames.map(esc).join('、')}）。</p>` : ''}
        ${REMOTE && !accepting ? '<p class="res-note">現在、回答の受付を停止しています（config.js の ACCEPTING）。</p>' : ''}
      </section>
      ${allResponses.length ? responseListHTML(form, allResponses, new Set(dropped), nameQ) : ''}
      ${responses.length
        ? form.pages.map((p, pi) => `
            ${form.pages.length > 1 ? `<h2 class="res-page-title">ページ ${pi + 1}${p.title ? `：${esc(p.title)}` : ''}</h2>` : ''}
            ${p.questions.map((q) => resultCardHTML(q, ctx)).join('')}`).join('')
        : '<section class="card"><p class="empty">まだ回答がありません。</p></section>'}
    </main>`;
  setupHeader(form);

  $('#csv').addEventListener('click', () => downloadCSV(form, responses));
  if (allResponses.length) setupResponseList(id);

  if (REMOTE) {
    $('#reload').addEventListener('click', () => renderResults(id));
    $('#logout').addEventListener('click', () => {
      setAdminKey('');
      renderKeyPrompt(id, false);
    });
    return;
  }

  // 回答の受付 ON/OFF
  $('#accepting').addEventListener('change', async (e) => {
    form.acceptingResponses = e.target.checked;
    form.updatedAt = Date.now();
    await Store.saveForm(form);
    toast(e.target.checked ? '回答の受付を再開しました' : '回答の受付を停止しました');
  });

  $('#delAll').addEventListener('click', async () => {
    if (!confirm(`${allResponses.length}件の回答をすべて削除しますか？\nこの操作は元に戻せません。`)) return;
    await Store.deleteResponses(id);
    renderResults(id);
  });
}

/* ---------- 個別の回答の一覧（確認・削除） ---------- */

let keepResponseListOpen = false; // 削除後に描き直すとき、一覧を開いたままにする

function responseListHTML(form, all, droppedSet, nameQ) {
  const others = allQuestions(form).filter((q) => q !== nameQ);
  const summaryOf = (r) => {
    const s = others.map((q) => answerToText(q, r.answers[q.id])).filter(Boolean).join(' / ');
    return s.length > 120 ? s.slice(0, 120) + '…' : s;
  };
  const rows = all.slice().sort((a, b) => b.submittedAt - a.submittedAt); // 新しい順
  const open = keepResponseListOpen;
  keepResponseListOpen = false;

  return `
    <details class="card resp-list" ${open ? 'open' : ''}>
      <summary>個別の回答を確認・削除する（${all.length}件）</summary>
      <p class="hint">テスト用などの不要な回答にチェックを入れて「選択した回答を削除」を押してください。${REMOTE ? 'スプレッドシートの行も削除されます。' : ''}</p>
      <div class="resp-actions">
        <label class="resp-all"><input type="checkbox" id="checkAll"> すべて選択</label>
        <button type="button" class="btn danger" id="delSelected" disabled>選択した回答を削除</button>
      </div>
      <ul class="resp-items">
        ${rows.map((r) => `
          <li class="resp-item ${droppedSet.has(r) ? 'old' : ''}">
            <label>
              <input type="checkbox" class="resp-check" value="${esc(r.id)}">
              <div class="resp-main">
                <div class="resp-top">
                  <span class="resp-name">${esc((nameQ && r.answers[nameQ.id]) || '（名前なし）')}</span>
                  <span class="resp-time">${formatDateTime(r.submittedAt)}</span>
                  ${droppedSet.has(r) ? '<span class="resp-tag">古い回答（集計外）</span>' : ''}
                </div>
                <div class="resp-summary">${esc(summaryOf(r)) || '<span class="hint small">（ほかの回答なし）</span>'}</div>
              </div>
            </label>
          </li>`).join('')}
      </ul>
    </details>`;
}

function setupResponseList(formId) {
  const list = $('.resp-list');
  const checks = [...list.querySelectorAll('.resp-check')];
  const checkAll = $('#checkAll');
  const delBtn = $('#delSelected');

  const selectedIds = () => checks.filter((c) => c.checked).map((c) => c.value);
  const refresh = () => {
    const n = selectedIds().length;
    delBtn.disabled = n === 0;
    delBtn.textContent = n ? `選択した回答を削除（${n}件）` : '選択した回答を削除';
    checkAll.checked = n === checks.length;
    checkAll.indeterminate = n > 0 && n < checks.length;
    checks.forEach((c) => c.closest('.resp-item').classList.toggle('checked', c.checked));
  };
  checks.forEach((c) => c.addEventListener('change', refresh));
  checkAll.addEventListener('change', () => {
    checks.forEach((c) => { c.checked = checkAll.checked; });
    refresh();
  });

  delBtn.addEventListener('click', async () => {
    const ids = selectedIds();
    if (!ids.length) return;
    if (!confirm(`選択した${ids.length}件の回答を削除しますか？\nこの操作は元に戻せません。`)) return;
    delBtn.disabled = true;
    delBtn.textContent = '削除中…';
    try {
      const n = await Store.deleteResponseIds(formId, ids);
      keepResponseListOpen = true;
      await renderResults(formId);
      toast(`${n}件の回答を削除しました`);
    } catch (err) {
      console.error(err);
      if (err instanceof AuthError) {
        setAdminKey('');
        return renderKeyPrompt(formId, true);
      }
      toast(err.message === 'old_script'
        ? '削除できませんでした。Apps Script（Code.gs）を新しいものに更新してください'
        : '削除に失敗しました。通信環境を確認してもう一度お試しください');
      refresh();
    }
  });
}

// 横棒グラフの1行
function barRowHTML(labelHTML, count, total, extraClass = '') {
  const pct = total ? Math.round((count / total) * 1000) / 10 : 0;
  return `
    <div class="bar-row ${extraClass}">
      <div class="bar-label">${labelHTML}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      <div class="bar-value">${count}<span>（${pct}%）</span></div>
    </div>`;
}

// 名前のチップ一覧
function chipsHTML(list) {
  return list.length
    ? `<div class="chips">${list.map((n) => `<span class="chip">${esc(n)}</span>`).join('')}</div>`
    : '<p class="hint small">なし</p>';
}

// 質問ごとの集計カード
function resultCardHTML(q, ctx) {
  const { responses, nameQ, nameOf } = ctx;
  // この質問に答えた回答（分岐で通らなかった人は含まれない）
  const rows = responses
    .map((r) => ({ name: nameOf(r), v: r.answers[q.id] }))
    .filter((x) => !isEmpty(x.v));
  const head = `
    <h3 class="res-q-title">${esc(q.title || '無題の質問')}</h3>
    <p class="res-q-meta">${rows.length}件の回答</p>`;
  let body;

  if (rows.length === 0) {
    body = '<p class="empty">この質問への回答はまだありません</p>';
  } else if (q.type === 'short' || q.type === 'paragraph') {
    // 記述式：回答一覧（新しい順）。名前の質問以外は名前付きで表示
    const withName = nameQ && q !== nameQ;
    body = `<ul class="text-answers">${rows.slice().reverse().map((x) => `
      <li>${withName ? `<span class="ans-name">${esc(x.name)}</span>` : ''}${esc(x.v)}</li>`).join('')}</ul>`;
  } else if (q.type === 'date') {
    body = dateResultHTML(q, rows);
  } else {
    // 選択式：選択肢ごとの件数と割合（チェックボックスは回答者数に対する割合）
    const counts = new Map(q.options.map((o) => [o, []]));
    rows.forEach((x) => (Array.isArray(x.v) ? x.v : [x.v]).forEach((o) => {
      if (!counts.has(o)) counts.set(o, []);
      counts.get(o).push(x.name);
    }));
    const entries = [...counts];
    if (q.type === 'radio') {
      // ラジオ：人数を大きく表示＋選択肢ごとの名前一覧
      body = `
        <div class="tiles">
          ${entries.map(([label, list]) => `
            <div class="tile">
              <div class="tile-num">${list.length}<small>人</small></div>
              <div class="tile-label">${esc(label)}</div>
            </div>`).join('')}
        </div>
        ${entries.map(([label, list]) => barRowHTML(esc(label), list.length, rows.length)).join('')}
        ${nameQ && q !== nameQ ? `
          <div class="name-groups">
            ${entries.map(([label, list]) => `
              <div class="name-group">
                <div class="name-group-title">${esc(label)}（${list.length}人）</div>
                ${chipsHTML(list)}
              </div>`).join('')}
          </div>` : ''}`;
    } else {
      body = entries.map(([label, list]) => barRowHTML(esc(label), list.length, rows.length)).join('');
    }
  }

  return `<section class="card res-card">${head}${body}</section>`;
}

// 日付選択の集計：最多日・日付ごとの人数・名前×日付の表
function dateResultHTML(q, rows) {
  const counts = new Map(DatePicker.listDates(q.dateStart, q.dateEnd).map((d) => [d, 0]));
  rows.forEach((x) => x.v.forEach((d) => counts.set(d, (counts.get(d) || 0) + 1)));
  const days = [...counts.keys()].sort();
  const max = Math.max(0, ...counts.values());
  const tops = new Set(days.filter((d) => counts.get(d) === max && max > 0));
  const wdClass = (d) => {
    const wd = DatePicker.parseISO(d).getDay();
    return wd === 0 ? 'sun' : wd === 6 ? 'sat' : '';
  };

  const best = tops.size
    ? `<div class="best-day">いちばん多い日：<strong>${[...tops].map(DatePicker.formatShort).join('、')}</strong>（${max}人 / ${rows.length}人中）</div>`
    : '';

  const bars = days.map((d) => {
    const label = `<span class="${wdClass(d)}">${DatePicker.formatShort(d)}</span>${tops.has(d) ? '<span class="top-badge">最多</span>' : ''}`;
    return barRowHTML(label, counts.get(d), rows.length, tops.has(d) ? 'top' : '');
  }).join('');

  // 名前 × 日付 の表（○ = 参加できる）
  const table = `
    <div class="matrix-wrap">
      <table class="matrix">
        <thead>
          <tr>
            <th class="sticky">名前</th>
            ${days.map((d) => {
              const dt = DatePicker.parseISO(d);
              return `<th class="${tops.has(d) ? 'top' : ''} ${wdClass(d)}">${dt.getMonth() + 1}/${dt.getDate()}<br><small>${DatePicker.WEEKDAYS[dt.getDay()]}</small></th>`;
            }).join('')}
          </tr>
        </thead>
        <tbody>
          ${rows.map((x) => `
            <tr>
              <th class="sticky">${esc(x.name)}</th>
              ${days.map((d) => `<td class="${tops.has(d) ? 'top' : ''}">${x.v.includes(d) ? '○' : ''}</td>`).join('')}
            </tr>`).join('')}
        </tbody>
        <tfoot>
          <tr>
            <th class="sticky">人数</th>
            ${days.map((d) => `<td class="${tops.has(d) ? 'top' : ''}">${counts.get(d)}</td>`).join('')}
          </tr>
        </tfoot>
      </table>
    </div>`;

  return `
    ${best}
    <h4 class="res-sub">誰が参加できるか</h4>
    ${table}
    <h4 class="res-sub">日付ごとの人数</h4>
    <div class="date-bars">${bars}</div>`;
}

// 回答をCSVで保存（Excelで文字化けしないようBOM付き）
function downloadCSV(form, responses) {
  const qs = allQuestions(form);
  const header = ['タイムスタンプ', ...qs.map((q) => q.title || '無題の質問')];
  const rows = responses.map((r) => [
    formatDateTime(r.submittedAt),
    ...qs.map((q) => answerToText(q, r.answers[q.id])),
  ]);
  const csv = [header, ...rows]
    .map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${form.title || '回答'}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* =========================================================
 * 起動
 * ========================================================= */
window.addEventListener('hashchange', router);
seedSamples().then(router);
