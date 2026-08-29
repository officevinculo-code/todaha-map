const ACTIVE_THEME_KEY = 'todaha_active_theme_id';

let themes = [];
let currentTheme = null;
let achievements = [];
let achievedPrefIds = new Set();
let openPrefId = null;
let objectUrls = [];

function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function prefById(id) {
  return PREFECTURES_GEO.find((f) => f.id === id);
}

function missionTextFor(theme, prefName) {
  if (!theme) return '';
  if (theme.missionTemplate.includes('{pref}')) {
    return theme.missionTemplate.replaceAll('{pref}', prefName);
  }
  return theme.missionTemplate;
}

function trackObjectUrl(url) {
  objectUrls.push(url);
  return url;
}

function revokeTrackedUrls() {
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls = [];
}

// ---------- 初期化 ----------

async function init() {
  renderMapSkeleton();
  themes = await Db.getThemes();

  if (themes.length === 0) {
    openThemeModal({ forceCreate: true });
    updateStats();
    return;
  }

  const savedId = localStorage.getItem(ACTIVE_THEME_KEY);
  currentTheme = themes.find((t) => t.id === savedId) || themes[0];
  await loadAchievementsForCurrentTheme();
  renderThemeName();
  updateMapColors();
  updateStats();
}

async function loadAchievementsForCurrentTheme() {
  if (!currentTheme) {
    achievements = [];
    achievedPrefIds = new Set();
    return;
  }
  achievements = await Db.getAchievementsByTheme(currentTheme.id);
  achievedPrefIds = new Set(achievements.map((a) => a.prefId));
  localStorage.setItem(ACTIVE_THEME_KEY, currentTheme.id);
}

function renderThemeName() {
  document.getElementById('current-theme-name').textContent = currentTheme
    ? currentTheme.name
    : 'テーマ未設定';
}

function updateStats() {
  const total = PREFECTURES_GEO.length;
  const done = achievedPrefIds.size;
  document.getElementById('stats-text').textContent = `${done} / ${total} 都道府県 達成`;
  document.getElementById('stats-bar-fill').style.width = `${(done / total) * 100}%`;
}

// ---------- 地図 ----------

function renderMapSkeleton() {
  const svg = document.getElementById('japan-map');
  svg.setAttribute('viewBox', JAPAN_MAP_VIEWBOX);
  svg.innerHTML = '';
  for (const feature of PREFECTURES_GEO) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', feature.path);
    path.setAttribute('data-pref-id', String(feature.id));
    path.setAttribute('class', 'pref-path');
    path.addEventListener('click', () => openPrefPanel(feature.id));
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = feature.name;
    path.appendChild(title);
    svg.appendChild(path);
  }
}

function updateMapColors() {
  document.querySelectorAll('.pref-path').forEach((path) => {
    const id = Number(path.getAttribute('data-pref-id'));
    path.classList.toggle('achieved', achievedPrefIds.has(id));
  });
}

// ---------- 都道府県パネル ----------

function openPrefPanel(prefId) {
  if (!currentTheme) {
    openThemeModal({ forceCreate: true });
    return;
  }
  openPrefId = prefId;
  renderPrefPanel();
  document.getElementById('pref-overlay').classList.remove('hidden');
  document.getElementById('pref-panel').classList.remove('hidden');
}

function closePrefPanel() {
  openPrefId = null;
  document.getElementById('pref-overlay').classList.add('hidden');
  document.getElementById('pref-panel').classList.add('hidden');
  revokeTrackedUrls();
}

function renderPrefPanel() {
  const feature = prefById(openPrefId);
  const body = document.getElementById('pref-panel-body');
  const prefAchievements = achievements.filter((a) => a.prefId === openPrefId);
  const isAchieved = prefAchievements.length > 0;

  const galleryHtml = prefAchievements
    .map((a) => {
      const url = trackObjectUrl(URL.createObjectURL(a.thumbBlob || a.blob));
      const date = new Date(a.createdAt).toLocaleDateString('ja-JP');
      return `
        <div class="gallery-item" data-achievement-id="${a.id}">
          <img src="${url}" alt="${feature.name}の達成写真" onerror="this.parentElement.classList.add('img-error')">
          <span class="gallery-item-date">${date}</span>
          <button class="gallery-item-delete" data-delete-id="${a.id}" aria-label="削除">×</button>
        </div>`;
    })
    .join('');

  body.innerHTML = `
    <h2>${feature.name}</h2>
    <span class="pref-mission-label">${escapeHtml(currentTheme.name)}</span>
    <p class="pref-mission-text">${escapeHtml(missionTextFor(currentTheme, feature.name))}</p>
    <span class="pref-status-badge ${isAchieved ? 'achieved' : 'unachieved'}">
      ${isAchieved ? `達成済み（${prefAchievements.length}件）` : '未達成'}
    </span>
    <div class="gallery">${galleryHtml}</div>
    <button id="pref-upload-btn" class="btn btn-primary">写真をアップロードして達成登録</button>
  `;

  document.getElementById('pref-upload-btn').addEventListener('click', () => {
    document.getElementById('file-input').click();
  });

  body.querySelectorAll('[data-delete-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('この写真の達成記録を削除しますか？')) return;
      await Db.deleteAchievement(btn.getAttribute('data-delete-id'));
      await loadAchievementsForCurrentTheme();
      updateMapColors();
      updateStats();
      renderPrefPanel();
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- アップロード（EXIF判定→確認モーダル） ----------

async function onFileChosen(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;

  const targetPrefId = openPrefId;
  const targetFeature = prefById(targetPrefId);
  const gps = await extractGPSFromFile(file);

  let matchResult = null;
  if (gps) {
    matchResult = findPrefectureByLatLng(gps.lat, gps.lng);
  }

  showConfirmModal({ file, gps, matchResult, targetFeature });
}

function showConfirmModal({ file, gps, matchResult, targetFeature }) {
  const body = document.getElementById('confirm-modal-body');
  const matchedFeature = matchResult ? matchResult.feature : null;

  let summaryHtml;
  if (!gps) {
    summaryHtml = `<div class="confirm-summary">この画像には位置情報が見つかりませんでした（位置情報がオフだった写真や、対応していない形式の場合があります）。登録する都道府県を選んでください。</div>`;
  } else if (!matchedFeature) {
    summaryHtml = `<div class="confirm-summary">位置情報はありましたが、都道府県を特定できませんでした。登録する都道府県を選んでください。</div>`;
  } else if (matchedFeature.id === targetFeature.id) {
    summaryHtml = `<div class="confirm-summary">位置情報から <strong>${escapeHtml(matchedFeature.name)}</strong> で撮影されたと判定しました。この内容で登録しますか？</div>`;
  } else {
    summaryHtml = `<div class="confirm-summary">位置情報からは <strong>${escapeHtml(matchedFeature.name)}</strong> と判定されましたが、現在開いているのは <strong>${escapeHtml(targetFeature.name)}</strong> です。登録する都道府県を選んでください。</div>`;
  }

  const defaultPrefId = matchedFeature ? matchedFeature.id : targetFeature.id;
  const optionsHtml = PREFECTURES_GEO.map(
    (f) => `<option value="${f.id}" ${f.id === defaultPrefId ? 'selected' : ''}>${f.name}</option>`
  ).join('');

  body.innerHTML = `
    ${summaryHtml}
    <label class="form-label">
      登録する都道府県
      <select id="confirm-pref-select">${optionsHtml}</select>
    </label>
    <div class="confirm-actions">
      <button id="confirm-save-btn" class="btn btn-primary">この内容で登録する</button>
      <button id="confirm-cancel-btn" class="btn btn-secondary">キャンセル</button>
    </div>
  `;

  document.getElementById('confirm-cancel-btn').addEventListener('click', closeConfirmModal);
  document.getElementById('confirm-save-btn').addEventListener('click', async () => {
    const prefId = Number(document.getElementById('confirm-pref-select').value);
    const chosenFeature = prefById(prefId);
    const saveBtn = document.getElementById('confirm-save-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中...';
    try {
      await saveAchievement({ file, gps, prefFeature: chosenFeature, exact: matchedFeature && matchedFeature.id === prefId });
      closeConfirmModal();
      if (openPrefId !== null) renderPrefPanel();
    } catch (e) {
      console.error(e);
      alert('保存に失敗しました。もう一度お試しください。');
      saveBtn.disabled = false;
      saveBtn.textContent = 'この内容で登録する';
    }
  });

  document.getElementById('confirm-modal-overlay').classList.remove('hidden');
  document.getElementById('confirm-modal').classList.remove('hidden');
}

function closeConfirmModal() {
  document.getElementById('confirm-modal-overlay').classList.add('hidden');
  document.getElementById('confirm-modal').classList.add('hidden');
}

async function saveAchievement({ file, gps, prefFeature, exact }) {
  const [mainBlob, thumbBlob] = await Promise.all([
    resizeImageToBlob(file, 1600, 0.85),
    resizeImageToBlob(file, 320, 0.8),
  ]);

  const record = {
    id: uuid(),
    themeId: currentTheme.id,
    prefId: prefFeature.id,
    prefName: prefFeature.name,
    blob: mainBlob,
    thumbBlob,
    lat: gps ? gps.lat : null,
    lng: gps ? gps.lng : null,
    source: gps ? (exact ? 'exif' : 'exif_fallback') : 'manual',
    createdAt: Date.now(),
  };

  await Db.addAchievement(record);
  achievements.push(record);
  achievedPrefIds.add(prefFeature.id);
  updateMapColors();
  updateStats();
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => resolve({ img, url });
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

// HEICはSafari系ブラウザ以外では <img> でデコードできないことが多い。
// その場合はリサイズを諦めて元ファイルをそのまま保存する（EXIF判定自体はブラウザ非依存で成功する）。
async function resizeImageToBlob(file, maxDim, quality) {
  try {
    const { img, url } = await loadImage(file);
    try {
      let { naturalWidth: width, naturalHeight: height } = img;
      if (!width || !height) throw new Error('画像のデコードに失敗しました');
      if (width > maxDim || height > maxDim) {
        const ratio = Math.min(maxDim / width, maxDim / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (!blob) throw new Error('画像のエンコードに失敗しました');
      return blob;
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (e) {
    console.warn('リサイズできなかったため元データを保存します（未対応の画像形式の可能性があります）', e);
    return file;
  }
}

// ---------- テーマ管理 ----------

function openThemeModal({ forceCreate = false } = {}) {
  renderThemeModal();
  document.getElementById('theme-modal-overlay').classList.remove('hidden');
  document.getElementById('theme-modal').classList.remove('hidden');
  document.getElementById('theme-modal-close').classList.toggle('hidden', forceCreate && themes.length === 0);
}

function closeThemeModal() {
  if (!currentTheme) return; // テーマが1つも無い間は閉じさせない
  document.getElementById('theme-modal-overlay').classList.add('hidden');
  document.getElementById('theme-modal').classList.add('hidden');
}

function renderThemeModal() {
  const list = document.getElementById('theme-list');
  if (themes.length === 0) {
    list.innerHTML = `<p class="theme-empty-hint">まだテーマがありません。まずは下のフォームから最初のテーマを作成してください。</p>`;
  } else {
    list.innerHTML = themes
      .map((t) => {
        const isActive = currentTheme && t.id === currentTheme.id;
        return `
          <div class="theme-row ${isActive ? 'active' : ''}">
            <div class="theme-row-main">
              <span class="theme-row-name">${escapeHtml(t.name)}</span>
              <span class="theme-row-progress">${escapeHtml(t.missionTemplate)}</span>
            </div>
            <div class="theme-row-actions">
              ${isActive ? '' : `<button class="btn btn-outline" style="width:auto;padding:8px 14px;" data-switch-id="${t.id}">切替</button>`}
              <button class="btn-danger-text" data-delete-theme-id="${t.id}">削除</button>
            </div>
          </div>`;
      })
      .join('');

    list.querySelectorAll('[data-switch-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        currentTheme = themes.find((t) => t.id === btn.getAttribute('data-switch-id'));
        await loadAchievementsForCurrentTheme();
        renderThemeName();
        updateMapColors();
        updateStats();
        closeThemeModal();
      });
    });

    list.querySelectorAll('[data-delete-theme-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-delete-theme-id');
        const target = themes.find((t) => t.id === id);
        if (!confirm(`テーマ「${target.name}」と、登録済みの達成記録・写真をすべて削除します。よろしいですか？`)) return;
        await Db.deleteTheme(id);
        themes = await Db.getThemes();
        if (currentTheme && currentTheme.id === id) {
          currentTheme = themes[0] || null;
          await loadAchievementsForCurrentTheme();
          renderThemeName();
          updateMapColors();
          updateStats();
        }
        renderThemeModal();
        if (themes.length === 0) openThemeModal({ forceCreate: true });
      });
    });
  }
}

async function handleThemeCreateSubmit(event) {
  event.preventDefault();
  const nameInput = document.getElementById('theme-name-input');
  const missionInput = document.getElementById('theme-mission-input');
  const name = nameInput.value.trim();
  const missionTemplate = missionInput.value.trim();
  if (!name || !missionTemplate) return;

  const theme = { id: uuid(), name, missionTemplate, createdAt: Date.now() };
  await Db.addTheme(theme);
  themes = await Db.getThemes();
  currentTheme = theme;
  await loadAchievementsForCurrentTheme();
  renderThemeName();
  updateMapColors();
  updateStats();

  nameInput.value = '';
  missionInput.value = '';
  renderThemeModal();
  document.getElementById('theme-modal-close').classList.remove('hidden');
  closeThemeModal();
}

// ---------- イベント束ね ----------

function bindGlobalEvents() {
  document.getElementById('pref-panel-close').addEventListener('click', closePrefPanel);
  document.getElementById('pref-overlay').addEventListener('click', closePrefPanel);

  document.getElementById('theme-open-btn').addEventListener('click', () => openThemeModal());
  document.getElementById('theme-modal-close').addEventListener('click', closeThemeModal);
  document.getElementById('theme-modal-overlay').addEventListener('click', closeThemeModal);

  document.getElementById('confirm-modal-close').addEventListener('click', closeConfirmModal);
  document.getElementById('confirm-modal-overlay').addEventListener('click', closeConfirmModal);

  document.getElementById('theme-create-form').addEventListener('submit', handleThemeCreateSubmit);
  document.getElementById('file-input').addEventListener('change', onFileChosen);
}

// file:// で直接開いた場合はService Worker非対応のため自動的に何もしない（登録失敗を握りつぶすだけ）。
// http(s)経由（自ホスト配信）で開いた場合のみオフラインキャッシュが有効になる。
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => {
      console.warn('Service Workerの登録に失敗しました（file://で開いている場合は仕様です）', e);
    });
  });
}

// 初回（テーマが無い状態）でもテーマ作成フォームは動作させる必要があるため、
// bindGlobalEvents は init() の分岐に関わらず一度だけ実行する。
document.addEventListener('DOMContentLoaded', () => {
  bindGlobalEvents();
  registerServiceWorker();
  init();
});
