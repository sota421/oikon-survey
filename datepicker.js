/* =========================================================
 * datepicker.js
 * 「なぞって選ぶ」日付選択コンポーネント（月カレンダー表示）
 *
 * 使い方:
 *   const dp = new DatePicker(要素, {
 *     start: '2026-11-16',          // 開始日（YYYY-MM-DD）
 *     end:   '2026-12-13',          // 終了日（YYYY-MM-DD）
 *     value: ['2026-11-19'],        // 初期選択（省略可）
 *     onChange: (dates) => {},      // 選択確定時に呼ばれる（YYYY-MM-DD の配列）
 *   });
 *   dp.getValue();  dp.setValue([...]);
 *
 * 仕組みのポイント:
 *   - 1ページ = 1か月のカレンダー（日曜始まり）。月の切り替えは ◀ ▶ ボタン（スクロールは使わない）
 *   - 開始日〜終了日の外の日は薄く表示し、選択できない
 *   - なぞると「押し始めた日〜指の下の日」が日付順にまとめて選択される（週をまたいでもOK）
 *   - 背景バーは週（カレンダーの行）ごとに分けて描く
 *   - Pointer Events でマウスとタッチを同じコードで扱う
 *   - カレンダー部分に touch-action:none を付け、ドラッグ中に画面がスクロールしないようにする
 *   - pointerdown 時に setPointerCapture するので、指がエリア外に出ても離すまで追跡できる
 *   - 指の下の日付は document.elementFromPoint() で判定し、隙間にいるときは一番近い日付を使う
 * ========================================================= */

(function (global) {
  'use strict';

  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
  const MAX_DAYS = 366; // 安全のため、扱う日数の上限

  /* ---------- 日付ユーティリティ ---------- */

  // 'YYYY-MM-DD' → Date（ローカル時刻の0時）
  function parseISO(str) {
    const [y, m, d] = String(str).split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  // Date → 'YYYY-MM-DD'
  function toISO(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // 開始日〜終了日の 'YYYY-MM-DD' 配列を作る（逆順で渡されても入れ替える）
  function listDates(start, end) {
    let s = parseISO(start);
    let e = parseISO(end);
    if (isNaN(s) || isNaN(e)) return [];
    if (s > e) [s, e] = [e, s];
    const out = [];
    const cur = new Date(s);
    while (cur <= e && out.length < MAX_DAYS) {
      out.push(toISO(cur));
      cur.setDate(cur.getDate() + 1);
    }
    return out;
  }

  // 表示用ラベル 例: '11/19(水)'
  function formatShort(iso) {
    const d = parseISO(iso);
    return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`;
  }

  /* ---------- コンポーネント本体 ---------- */

  class DatePicker {
    constructor(container, options = {}) {
      this.container = container;
      this.dates = listDates(options.start, options.end); // 選択できる全日付（インデックスで扱う）
      this.indexOf = new Map(this.dates.map((d, i) => [d, i]));
      this.weekday = this.dates.map((d) => parseISO(d).getDay());
      this.selected = new Set((options.value || []).filter((d) => this.indexOf.has(d)));
      this.onChange = options.onChange || function () {};
      this.readOnly = !!options.readOnly;

      this.drag = null;   // ドラッグ中の状態
      this.bars = [];     // 表示中の背景バー [{ el, from, to }]
      this.pages = this._buildPages();
      this.pageIndex = this._initialPage();

      this._build();
      this._renderPage();
    }

    /* ===== 公開API ===== */

    // 選択中の日付を昇順の配列で返す
    getValue() {
      return [...this.selected].sort();
    }

    // 選択を外部から設定する
    setValue(dates) {
      this.selected = new Set((dates || []).filter((d) => this.indexOf.has(d)));
      this._update();
    }

    /* ===== ページ（月）の組み立て ===== */

    // 範囲に含まれる月ごとに区切る。各ページは { year, month, from, to }（from/to = その月の選択可能な日のインデックス）
    _buildPages() {
      const pages = [];
      this.dates.forEach((iso, i) => {
        const d = parseISO(iso);
        const last = pages[pages.length - 1];
        if (last && last.year === d.getFullYear() && last.month === d.getMonth()) last.to = i;
        else pages.push({ year: d.getFullYear(), month: d.getMonth(), from: i, to: i });
      });
      return pages;
    }

    // 最初に表示する月：選択済みの最初の日 → 今日 → 先頭 の順で探す
    _initialPage() {
      const first = this.getValue()[0];
      const target = first != null ? this.indexOf.get(first) : this.indexOf.get(toISO(new Date()));
      if (target == null) return 0;
      return Math.max(0, this.pages.findIndex((p) => target >= p.from && target <= p.to));
    }

    /* ===== DOM 構築 ===== */

    _build() {
      this.container.innerHTML = '';
      const root = document.createElement('div');
      root.className = 'dp' + (this.readOnly ? ' dp-readonly' : '');
      this.root = root;

      if (this.dates.length === 0) {
        root.innerHTML = '<p class="dp-empty">日付の範囲が設定されていません</p>';
        this.container.appendChild(root);
        return;
      }

      root.innerHTML = `
        <div class="dp-header">
          <button type="button" class="dp-nav dp-prev" aria-label="前の月">◀</button>
          <div class="dp-label" aria-live="polite"></div>
          <button type="button" class="dp-nav dp-next" aria-label="次の月">▶</button>
        </div>
        <div class="dp-weekdays" aria-hidden="true">
          ${WEEKDAYS.map((w, i) => `<span class="dp-wd${i === 0 ? ' sun' : i === 6 ? ' sat' : ''}">${w}</span>`).join('')}
        </div>
        <div class="dp-track">
          <div class="dp-bars" aria-hidden="true"></div>
          <div class="dp-grid" role="group"></div>
        </div>`;
      this.container.appendChild(root);

      this.track = root.querySelector('.dp-track');
      this.barLayer = root.querySelector('.dp-bars');
      this.grid = root.querySelector('.dp-grid');
      this.label = root.querySelector('.dp-label');
      this.prevBtn = root.querySelector('.dp-prev');
      this.nextBtn = root.querySelector('.dp-next');

      // 1か月しかなければナビは不要
      if (this.pages.length <= 1) root.querySelector('.dp-header').classList.add('dp-header-single');

      this.prevBtn.addEventListener('click', () => this._goPage(this.pageIndex - 1));
      this.nextBtn.addEventListener('click', () => this._goPage(this.pageIndex + 1));

      if (!this.readOnly) {
        this.track.addEventListener('pointerdown', (e) => this._onDown(e));
        this.track.addEventListener('pointermove', (e) => this._onMove(e));
        this.track.addEventListener('pointerup', (e) => this._onUp(e));
        this.track.addEventListener('pointercancel', (e) => this._onCancel(e));
        // キーボード操作（Enter / Space）は click で1日ずつ切り替え。ポインター由来の click は無視する
        this.grid.addEventListener('click', (e) => {
          const btn = e.target.closest('.dp-day');
          if (!btn || e.detail !== 0) return;
          const d = this.dates[Number(btn.dataset.index)];
          this.selected.has(d) ? this.selected.delete(d) : this.selected.add(d);
          this._update();
          this.onChange(this.getValue());
        });
      }

      // サイズ変更時はバー位置を再計算（アニメーションなしで即座に）
      if ('ResizeObserver' in global) {
        this._ro = new ResizeObserver(() => this._renderBars(true));
        this._ro.observe(this.track);
      } else {
        global.addEventListener('resize', () => this._renderBars(true));
      }
    }

    // 月を切り替える
    _goPage(i) {
      if (i < 0 || i >= this.pages.length || this.drag) return;
      this.pageIndex = i;
      this._renderPage();
    }

    // 現在の月のカレンダーを作り直す
    _renderPage() {
      if (!this.grid) return;
      const page = this.pages[this.pageIndex];
      const first = new Date(page.year, page.month, 1);
      const daysInMonth = new Date(page.year, page.month + 1, 0).getDate();
      const html = [];

      // 1日の曜日に合わせて先頭に空きマス
      for (let k = 0; k < first.getDay(); k++) html.push('<div class="dp-cell"></div>');

      for (let day = 1; day <= daysInMonth; day++) {
        const d = new Date(page.year, page.month, day);
        const index = this.indexOf.get(toISO(d));
        const wd = d.getDay();
        const label = `${page.month + 1}月${day}日(${WEEKDAYS[wd]})`;
        if (index == null) {
          // 範囲外の日：薄く表示して選択不可
          html.push(`<div class="dp-cell"><span class="dp-day dp-out" aria-hidden="true">${day}</span></div>`);
        } else {
          html.push(`<div class="dp-cell"><button type="button" class="dp-day" data-index="${index}" aria-label="${label}">${day}</button></div>`);
        }
      }
      this.grid.innerHTML = html.join('');
      this.buttons = [...this.grid.querySelectorAll('button.dp-day')];

      // ページが変わったらバーは作り直す
      this.bars.forEach((b) => b.el.remove());
      this.bars = [];

      this.label.textContent = `${page.year}年${page.month + 1}月`;
      this.prevBtn.disabled = this.pageIndex === 0;
      this.nextBtn.disabled = this.pageIndex === this.pages.length - 1;

      this._update(true);
    }

    /* ===== 選択状態の計算 ===== */

    // いま画面に表示すべき選択集合（ドラッグ中はプレビュー）
    _displaySet() {
      if (!this.drag) return this.selected;
      // 選択済みの日から始めた場合は「解除」モード（タップならその1日だけ、なぞればその範囲を解除）
      const { anchor, current, mode } = this.drag;
      const set = new Set(this.selected);
      const lo = Math.min(anchor, current);
      const hi = Math.max(anchor, current);
      for (let i = lo; i <= hi; i++) {
        if (mode === 'add') set.add(this.dates[i]);
        else set.delete(this.dates[i]);
      }
      return set;
    }

    /* ===== 表示の更新 ===== */

    _update(instant = false) {
      if (!this.buttons) return;
      const set = this._displaySet();
      this.buttons.forEach((btn) => {
        const on = set.has(this.dates[Number(btn.dataset.index)]);
        btn.classList.toggle('selected', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      this._renderBars(instant, set);
    }

    // 選択範囲の後ろに敷くカプセル型バーを描く（週の行ごとに1本）
    _renderBars(instant = false, set = this._displaySet()) {
      if (!this.buttons || this.buttons.length === 0) return;
      const page = this.pages[this.pageIndex];

      // 連続して選択されている範囲（run）を求める。日曜日で行が変わるのでそこで区切る
      const runs = [];
      for (let i = page.from; i <= page.to; i++) {
        if (!set.has(this.dates[i])) continue;
        const last = runs[runs.length - 1];
        if (last && last.to === i - 1 && this.weekday[i] !== 0) last.to = i;
        else runs.push({ from: i, to: i });
      }

      const trackRect = this.track.getBoundingClientRect();
      const pad = 3; // 丸の外側にはみ出す余白
      const btnOf = (i) => this.buttons[i - page.from];

      // 既存バーをなるべく使い回す（範囲が重なるものを同じバーとみなす）→ なめらかに伸び縮みする
      const unused = [...this.bars];
      const next = [];
      runs.forEach((run) => {
        const r1 = btnOf(run.from).getBoundingClientRect();
        const r2 = btnOf(run.to).getBoundingClientRect();
        const style = {
          left: `${r1.left - trackRect.left - pad}px`,
          top: `${r1.top - trackRect.top - pad}px`,
          width: `${r2.right - r1.left + pad * 2}px`,
          height: `${r1.height + pad * 2}px`,
        };
        const idx = unused.findIndex((b) => b.from <= run.to && b.to >= run.from);
        let bar;
        if (idx >= 0) {
          bar = unused.splice(idx, 1)[0];
        } else {
          // 新しいバー：最初の位置はアニメーションさせずに置く（出現はCSSのフェードで表現）
          const el = document.createElement('div');
          el.className = 'dp-bar dp-bar-new';
          Object.assign(el.style, style);
          this.barLayer.appendChild(el);
          bar = { el };
        }
        bar.el.classList.toggle('dp-bar-instant', instant);
        Object.assign(bar.el.style, style);
        bar.from = run.from;
        bar.to = run.to;
        next.push(bar);
      });
      unused.forEach((b) => b.el.remove());
      this.bars = next;
    }

    /* ===== ポインター操作 ===== */

    // 指（マウス）の座標から日付のインデックスを求める
    _indexAt(clientX, clientY) {
      // カレンダーの外に出ていても、内側に寄せた座標で判定する
      const gridRect = this.grid.getBoundingClientRect();
      const x = Math.min(Math.max(clientX, gridRect.left + 1), gridRect.right - 1);
      const y = Math.min(Math.max(clientY, gridRect.top + 1), gridRect.bottom - 1);

      const el = document.elementFromPoint(x, y);
      const btn = el && el.closest ? el.closest('button.dp-day') : null;
      if (btn && this.grid.contains(btn)) return Number(btn.dataset.index);

      // 丸と丸の隙間・範囲外の日の上・エリア外 → 中心が一番近い日付を選ぶ
      let best = null;
      let bestDist = Infinity;
      this.buttons.forEach((b) => {
        const r = b.getBoundingClientRect();
        const dx = x - (r.left + r.width / 2);
        const dy = y - (r.top + r.height / 2);
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          bestDist = dist;
          best = Number(b.dataset.index);
        }
      });
      return best;
    }

    _onDown(e) {
      if (this.drag) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return; // 左クリックのみ
      // 選択できる丸ボタンを押したときだけ開始
      const btn = e.target.closest('button.dp-day');
      if (!btn) return;
      const index = Number(btn.dataset.index);

      e.preventDefault(); // テキスト選択やゴーストクリックを防ぐ
      this.track.setPointerCapture(e.pointerId); // エリア外に出ても pointermove を受け取る

      this.drag = {
        pointerId: e.pointerId,
        anchor: index,      // 押し始めた日
        current: index,     // いま指がある日
        moved: false,       // 別の日まで動いたか
        mode: this.selected.has(this.dates[index]) ? 'remove' : 'add',
      };
      this.root.classList.add('dp-dragging');
      this._update();
    }

    _onMove(e) {
      if (!this.drag || e.pointerId !== this.drag.pointerId) return;
      const index = this._indexAt(e.clientX, e.clientY);
      if (index == null || index === this.drag.current) return;
      this.drag.current = index;
      if (index !== this.drag.anchor) this.drag.moved = true;
      this._update();
    }

    _onUp(e) {
      if (!this.drag || e.pointerId !== this.drag.pointerId) return;
      // プレビューの内容で確定する
      this.selected = this._displaySet();
      this._endDrag(e);
      this.onChange(this.getValue());
    }

    _onCancel(e) {
      if (!this.drag || e.pointerId !== this.drag.pointerId) return;
      // OSによる中断などは確定せずに元へ戻す
      this._endDrag(e);
    }

    _endDrag(e) {
      if (this.track.hasPointerCapture(e.pointerId)) this.track.releasePointerCapture(e.pointerId);
      this.drag = null;
      this.root.classList.remove('dp-dragging');
      this._update();
    }
  }

  // ユーティリティも外から使えるようにしておく（結果画面などで利用）
  DatePicker.listDates = listDates;
  DatePicker.parseISO = parseISO;
  DatePicker.toISO = toISO;
  DatePicker.formatShort = formatShort;
  DatePicker.WEEKDAYS = WEEKDAYS;

  global.DatePicker = DatePicker;
})(window);
