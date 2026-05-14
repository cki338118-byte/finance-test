const SUPABASE_URL = 'https://enthswnpuhvmxyjfltms.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVudGhzd25wdWh2bXh5amZsdG1zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzNDA3MzcsImV4cCI6MjA5MzkxNjczN30.2KNWdop3LP5RwDqNuK_ZDnWQAoyKQ-gJQ0Z0FXc6XPY';

let supabaseClient;
try {
  supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} catch (error) {
  console.error("Ошибка инициализации Supabase:", error);
}

const screenLogin = document.getElementById('screen-login');
const screenSelection = document.getElementById('screen-selection');
const screenQuiz = document.getElementById('screen-quiz');
const screenResult = document.getElementById('screen-result');
const screenAdmin = document.getElementById('screen-admin');

let currentAdminTab = 'subjects';

const TEST_TITLES = {
  macroeconomics: 'Макроэкономика',
  personal_finance: 'Персональные финансы',
  portfolio_theory: 'Теория портфеля',
  econometrics: 'Эконометрика',
  bank_accounting: 'Бухгалтерия в банке',
  bank_accounting_records: 'Бухгалтерский учет в банке',
  green_economy: 'Зеленая экономика',
  money_and_banks: 'Деньги и банки',
  finance: 'Финансы'
};

const state = {
  currentUser: null,
  currentTestKey: null,
  currentPartName: null,
  questions: [],
  currentIndex: 0,
  score: 0,
  wrongQuestions: [],
  isRepeatMode: false,
  
  qStates: {}, 
  
  adminQuestions: [],
  adminUsers: [],
  adminGroups: [],
  activeSubjectKey: null,
  editingQuestionId: null,
  activeGroupManager: null
};

const SESSION_LIMIT_MS = 5 * 60 * 60 * 1000;
let sessionCheckInterval = null;
let isLoggingIn = false;
let allStudentsCache = []; 

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function cloneQuestion(q) {
  return { id: q.id, q: q.q, a: Array.isArray(q.a) ? [...q.a] : [], c: q.c, part_name: q.part_name };
}

function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function showScreen(activeId) {
  const screens = [screenLogin, screenSelection, screenQuiz, screenResult, screenAdmin];
  screens.forEach(s => { if(s) s.classList.add('hidden'); });
  const target = document.getElementById(activeId);
  if(target) {
      target.classList.remove('hidden');
      if (activeId === 'screen-selection' || activeId === 'screen-admin') {
          target.innerHTML = '<h2 style="text-align:center; padding: 50px; color:#6b7280;">⏳ Загрузка данных...</h2>';
      }
  }
}

function setSavedUser(user) {
  localStorage.setItem('user', JSON.stringify(user));
}

function clearSavedUser() {
  localStorage.removeItem('user');
}

function saveTestProgress(isAnswered = false) {
  if (!state.currentTestKey) return;
  const progress = {
    currentTestKey: state.currentTestKey,
    currentPartName: state.currentPartName,
    questions: state.questions,
    currentIndex: isAnswered ? state.currentIndex + 1 : state.currentIndex,
    score: state.score,
    wrongQuestions: state.wrongQuestions,
    isRepeatMode: state.isRepeatMode,
    qStates: state.qStates
  };
  localStorage.setItem('test_progress', JSON.stringify(progress));
}

function clearTestProgress() {
  localStorage.removeItem('test_progress');
}

function getTestTitle(key) {
  return TEST_TITLES[key] || 'Тест';
}

async function getIPAddress() {
  try {
    const response = await fetch('https://api.ipify.org?format=json');
    const data = await response.json();
    return data.ip;
  } catch (e) {
    return 'Скрыт/VPN';
  }
}

async function securityCheck() {
  if (!state.currentUser || state.currentUser.role === 'admin' || state.currentUser.role === 'superadmin') return;

  const { data: userData } = await supabaseClient
    .from('users')
    .select('session_token')
    .eq('id', state.currentUser.id)
    .single();

  if (userData && userData.session_token !== state.currentUser.session_token) {
    alert('⚠️ Ваш аккаунт был использован на другом устройстве. Выполнен автоматический выход.');
    logout(true);
    return;
  }

  if (state.currentTestKey && !state.isRepeatMode) {
    const now = new Date().toISOString();
    const { data: accessData } = await supabaseClient
      .from('test_access')
      .select('id')
      .eq('username', state.currentUser.username)
      .eq('test_key', state.currentTestKey)
      .eq('is_active', true)
      .lte('start_time', now)
      .gte('end_time', now);

    if (!accessData || accessData.length === 0) {
      alert('⛔ Администратор закрыл вам доступ к этому тесту (или вышло время). Тест прерван.');
      clearTestProgress();
      backToSelection();
    }
  }
}

function renderLogin() {
  showScreen('screen-login');
  screenLogin.innerHTML = `
    <h1>Вход в систему</h1>
    <div class="muted">Введите логин и пароль</div>
    <input id="username" placeholder="Логин" autocomplete="username" />
    <input id="password" type="password" placeholder="Пароль" autocomplete="current-password" />
    <button id="login-btn" class="btn-ok">Войти</button>
    <div class="small-note">Доступ строго контролируется. Нарушители блокируются по IP.</div>
  `;
  document.getElementById('login-btn').addEventListener('click', handleLogin);
  document.getElementById('password').addEventListener('keydown', (e) => { 
      if (e.key === 'Enter' && !isLoggingIn) handleLogin(); 
  });
}

async function handleLogin() {
  if (isLoggingIn) return;

  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value.trim();
  if (!username || !password) { alert('Введите логин и пароль'); return; }

  isLoggingIn = true;
  const loginBtn = document.getElementById('login-btn');
  const originalBtnText = loginBtn.innerText;
  loginBtn.innerText = 'Загрузка...';
  loginBtn.disabled = true;
  loginBtn.style.opacity = '0.7';

  const userIP = await getIPAddress();
  
  if (userIP !== 'Скрыт/VPN') {
    const { data: banData } = await supabaseClient.from('banned_ips').select('*').eq('ip_address', userIP).single();
    if (banData) {
      alert('⛔ Доступ с вашего IP-адреса заблокирован администратором.');
      isLoggingIn = false;
      loginBtn.innerText = originalBtnText;
      loginBtn.disabled = false;
      loginBtn.style.opacity = '1';
      return;
    }
  }

  const { data, error } = await supabaseClient.from('users').select('*').eq('username', username).eq('password', password).single();
  
  if (error || !data) { 
      alert('Неверный логин или пароль'); 
      isLoggingIn = false;
      loginBtn.innerText = originalBtnText;
      loginBtn.disabled = false;
      loginBtn.style.opacity = '1';
      return; 
  }

  const sessionToken = Math.random().toString(36).substring(2, 15);
  await supabaseClient.from('users').update({ session_token: sessionToken }).eq('id', data.id);

  const deviceInfo = navigator.userAgent.substring(0, 50) + "...";
  await supabaseClient.from('login_history').insert([{ username: data.username, ip_address: userIP }]);

  const sessionData = { ...data, session_token: sessionToken, loginTimestamp: Date.now() };
  state.currentUser = sessionData;
  setSavedUser(sessionData);

  if (sessionCheckInterval) clearInterval(sessionCheckInterval);
  sessionCheckInterval = setInterval(securityCheck, 15000);

  isLoggingIn = false;

  if (data.role === 'admin' || data.role === 'superadmin') await openAdminPanel();
  else await renderSelection();
}

async function changeMyPassword() {
  const newPassword = prompt('Введите новый пароль (оставьте пустым для отмены):');
  if (!newPassword || newPassword.trim() === '') return;

  const { error } = await supabaseClient.from('users').update({ password: newPassword.trim() }).eq('id', state.currentUser.id);

  if (error) alert('Ошибка при смене пароля.');
  else {
    alert('Пароль успешно изменен!');
    state.currentUser.password = newPassword.trim();
    setSavedUser(state.currentUser);
    if (state.currentUser.role === 'admin' || state.currentUser.role === 'superadmin') openAdminPanel();
  }
}

async function renderSelection() {
  showScreen('screen-selection');
  const now = new Date().toISOString();

  const { data, error } = await supabaseClient
    .from('test_access')
    .select('*')
    .eq('username', state.currentUser.username)
    .eq('is_active', true)
    .lte('start_time', now)
    .gte('end_time', now);

  if (error) { screenSelection.innerHTML = `<h1 style="color:red; text-align:center; margin-top:20px;">Ошибка доступа к базе</h1>`; return; }

  let html = `
    <div class="screen-top">
      <div class="left">
        <h1 class="title-left">Доступные тесты</h1>
        <div class="subtitle-left">Пользователь: ${escapeHtml(state.currentUser.username)}</div>
      </div>
      <div class="right">
        <button class="btn-gray" onclick="renderSelection()">🔄 Обновить</button>
        <button class="btn-gray" onclick="changeMyPassword()">🔑 Пароль</button>
        <button class="btn-bad" onclick="logout()">🚪 Выйти</button>
      </div>
    </div>
  `;

  if (!data.length) {
      html += `<div class="muted">Сейчас вам недоступны тесты</div>`;
      screenSelection.innerHTML = html;
      return;
  }
  
  const testKeys = data.map(d => d.test_key);
  const { data: qData } = await supabaseClient.from('questions').select('test_key, part_name').in('test_key', testKeys);
  
  const partsMap = {};
  testKeys.forEach(k => partsMap[k] = new Set());
  
  if (qData) {
      qData.forEach(q => {
          partsMap[q.test_key].add(q.part_name || 'Основная часть');
      });
  }

  html += `<div style="max-width:600px; margin:0 auto;">`;
  data.forEach(test => { 
      const parts = Array.from(partsMap[test.test_key] || ['Основная часть']);
      
      let partsButtons = parts.map(p => 
          `<button class="btn-ok" style="margin:0; margin-bottom:5px; width:auto; padding:8px 15px; font-size:13px;" onclick="startTest('${test.test_key}', 'part', '${escapeHtml(p)}')">▶️ ${escapeHtml(p)}</button>`
      ).join(' ');

      html += `
      <div class="card" style="box-shadow:none; border:1px solid #d7dce3; margin-bottom:15px; text-align:left;">
          <h3 style="margin-top:0; margin-bottom:12px;">${escapeHtml(getTestTitle(test.test_key))}</h3>
          <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom: 10px;">
              ${partsButtons}
          </div>
          <div style="display:flex; gap:10px; flex-wrap:wrap; border-top: 1px solid #eee; padding-top: 10px;">
              <button class="btn-bad" style="margin:0; width:auto; padding:8px 15px; font-size:13px;" onclick="startTest('${test.test_key}', 'wrong')">❌ Работа над ошибками</button>
              <button class="btn-gray" style="margin:0; width:auto; padding:8px 15px; font-size:13px;" onclick="startTest('${test.test_key}', 'favorite')">⭐ Избранные</button>
          </div>
      </div>
      `; 
  });
  html += `</div>`;
  
  screenSelection.innerHTML = html;
}

window.pauseTest = async function() {
    if (!confirm('Приостановить тест и вернуться в меню? Ваш прогресс будет сохранен.')) return;
    
    if (!state.isRepeatMode) {
        document.getElementById('screen-quiz').innerHTML = '<h2 style="text-align:center; padding: 50px;">Сохранение...</h2>';
        await saveResult('incomplete');
    }
    
    state.currentTestKey = null;
    state.currentPartName = null;
    state.questions = [];
    state.currentIndex = 0;
    state.score = 0;
    
    renderSelection();
};

function renderQuizShell() {
  showScreen('screen-quiz');
  screenQuiz.innerHTML = `
    <div class="screen-top">
      <div class="left" style="display:flex; align-items:center;">
        <button class="btn-gray" style="padding:6px 12px; margin-right:15px; font-size:14px; width:auto;" onclick="pauseTest()">🔙 Назад</button>
        <div>
            <h1 id="quiz-title" class="title-left" style="margin:0;">
                ${escapeHtml(getTestTitle(state.currentTestKey))}
                ${state.currentPartName ? `<span style="font-size:16px; color:#888;">(${escapeHtml(state.currentPartName)})</span>` : ''}
            </h1>
            <div class="subtitle-left">Пользователь: ${escapeHtml(state.currentUser.username)}</div>
        </div>
      </div>
      <div class="right"><button class="btn-bad" onclick="logout()">🚪 Выйти</button></div>
    </div>
    <div id="counter"></div>
    <div class="progress"><div class="progress-bar" id="progress-bar"></div></div>
    <div id="question" style="font-size:18px;"></div>
    <div id="options"></div>
    <button id="next-btn" class="hidden btn-ok" onclick="nextQuestion()">Следующий вопрос</button>
  `;
}

function renderResult() {
  showScreen('screen-result');
  const total = state.questions.length;
  const wrong = total - state.score;
  const percent = total ? Math.round((state.score / total) * 100) : 0;

  let text = state.isRepeatMode ? 'Тренировка завершена (в базу не сохраняется).' : 'Результат сохранён.';
  if (!state.isRepeatMode) {
    if (percent >= 90) text += ' Отличный результат.';
    else if (percent >= 60) text += ' проходной.';
    else if (percent >= 0) text += ' пересдача.';
    else text += ' .';
  }

  screenResult.innerHTML = `
    <div class="screen-top">
      <div class="left">
        <h1 class="title-left">Тест завершён</h1>
        <div class="subtitle-left">Пользователь: ${escapeHtml(state.currentUser.username)}</div>
      </div>
      <div class="right"><button class="btn-bad" onclick="logout()">🚪 Выйти</button></div>
    </div>
    <div class="result-score">${state.score} / ${total}</div>
    <div class="result-meta">Правильных: ${state.score}, ошибок: ${wrong}, процент: ${percent}%</div>
    <div class="muted">${escapeHtml(text)}</div>
    <div class="toolbar">
      <button class="btn-gray" onclick="backToSelection()">К выбору тестов</button>
    </div>
  `;
}

function switchAdminTab(tabId) {
  currentAdminTab = tabId;
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
  const btn = document.getElementById('btn-' + tabId);
  const content = document.getElementById('tab-' + tabId);
  if(btn && content) {
    btn.classList.add('active');
    content.classList.add('active');
  }
}

async function createGroup() {
    const groupName = document.getElementById('new-group-input').value.trim();
    if (!groupName) return alert('Введите название группы');
    const { error } = await supabaseClient.from('groups').insert([{ name: groupName }]);
    if (error) alert('Ошибка создания (возможно группа уже существует)');
    else openAdminPanel();
}

async function deleteGroup(id, name) {
    if (!confirm(`Удалить группу "${name}"? Все студенты в ней будут переведены в статус "Без группы".`)) return;
    await supabaseClient.from('users').update({ group_name: 'Без группы' }).eq('group_name', name);
    await supabaseClient.from('groups').delete().eq('id', id);
    openAdminPanel();
}

function openGroupManager(groupName) {
    state.activeGroupManager = groupName;
    document.getElementById('students-main-view').classList.add('hidden');
    document.getElementById('group-editor-view').classList.remove('hidden');
    
    document.getElementById('group-editor-title').innerText = `Состав группы: ${escapeHtml(groupName)}`;
    
    const groupUsers = state.adminUsers.filter(u => u.group_name === groupName && u.role === 'student');
    const groupUsersHtml = groupUsers.length ? groupUsers.map(u => `
        <tr>
            <td>${escapeHtml(u.username)}</td>
            <td><button class="btn-bad" style="padding:6px 12px; width:auto; font-size:12px;" onclick="removeUserFromGroup(${u.id})">Исключить</button></td>
        </tr>
    `).join('') : `<tr><td colspan="2" class="muted">В группе пока нет студентов</td></tr>`;
    
    document.getElementById('group-members-list').innerHTML = `<table><tr><th>Студент</th><th>Действие</th></tr>${groupUsersHtml}</table>`;

    const availableUsers = state.adminUsers.filter(u => u.group_name !== groupName && u.role === 'student');
    const optionsHtml = availableUsers.length ? availableUsers.map(u => `<option value="${u.id}">${escapeHtml(u.username)} (сейчас: ${escapeHtml(u.group_name || 'Без группы')})</option>`).join('') : `<option value="">Нет доступных студентов</option>`;
    
    document.getElementById('add-to-group-select').innerHTML = optionsHtml;
}

function closeGroupManager() {
    state.activeGroupManager = null;
    document.getElementById('group-editor-view').classList.add('hidden');
    document.getElementById('students-main-view').classList.remove('hidden');
}

async function addUserToGroup() {
    const select = document.getElementById('add-to-group-select');
    const userId = select.value;
    if (!userId) return alert('Выберите студента');
    
    await supabaseClient.from('users').update({ group_name: state.activeGroupManager }).eq('id', userId);
    await openAdminPanel(); 
}

async function removeUserFromGroup(userId) {
    if (!confirm('Исключить студента из группы?')) return;
    await supabaseClient.from('users').update({ group_name: 'Без группы' }).eq('id', userId);
    await openAdminPanel();
}

async function openSubjectManager(testKey) {
  state.activeSubjectKey = testKey;
  document.getElementById('subjects-list-container').classList.add('hidden');
  document.getElementById('subject-editor-container').classList.remove('hidden');
  document.getElementById('subject-editor-title').innerText = 'Загрузка вопросов...';

  const { data, error } = await supabaseClient.from('questions').select('*').eq('test_key', testKey).order('id', { ascending: true });
  if (error) { alert('Ошибка загрузки вопросов'); return; }

  state.adminQuestions = data || [];
  renderSubjectQuestionsList();
}

function closeSubjectManager() {
  state.activeSubjectKey = null;
  state.editingQuestionId = null;
  document.getElementById('subject-editor-container').classList.add('hidden');
  document.getElementById('subjects-list-container').classList.remove('hidden');
}

window.parseAndImportQuestions = async function() {
    const text = document.getElementById('import-text').value;
    const partName = document.getElementById('import-part-name').value.trim() || 'Основная часть';
    
    if (!text) return alert('Вставьте текст с вопросами!');
    
    document.getElementById('import-btn').innerText = 'Импорт...';
    document.getElementById('import-btn').disabled = true;

    const blocks = text.split('+++++').filter(b => b.trim());
    const questionsToInsert = [];
    
    for (let block of blocks) {
        const firstSeparatorIdx = block.search(/====/);
        if (firstSeparatorIdx === -1) continue;
        
        const qText = block.substring(0, firstSeparatorIdx).trim();
        const optionsString = block.substring(firstSeparatorIdx);
        
        const optionParts = optionsString.split('====').filter(o => o.trim());
        const options = [];
        let correctIdx = 0;
        
        for (let i = 0; i < optionParts.length; i++) {
            let part = optionParts[i].trim();
            if (part.startsWith('#')) {
                correctIdx = i;
                options.push(part.substring(1).trim());
            } else {
                options.push(part);
            }
        }
        
        if (options.length > 0) {
            questionsToInsert.push({ test_key: state.activeSubjectKey, part_name: partName, q: qText, a: options, c: correctIdx });
        }
    }
    
    if (!questionsToInsert.length) {
        alert('Вопросы не распознаны. Проверьте правильность расстановки +++++ и ====');
        document.getElementById('import-btn').innerText = 'Импортировать вопросы';
        document.getElementById('import-btn').disabled = false;
        return;
    }

    const { error } = await supabaseClient.from('questions').insert(questionsToInsert);
    
    if (error) {
        alert('Ошибка при импорте в базу данных');
        console.error(error);
    } else {
        alert(`Успешно импортировано ${questionsToInsert.length} вопросов в раздел "${partName}"!`);
        document.getElementById('import-text').value = '';
        openSubjectManager(state.activeSubjectKey);
    }
};

window.toggleAllQuestions = function(checkbox) {
    document.querySelectorAll('.question-checkbox').forEach(cb => cb.checked = checkbox.checked);
};

window.deleteSelectedQuestions = async function() {
    const selectedIds = [...document.querySelectorAll('.question-checkbox:checked')].map(cb => parseInt(cb.value));
    
    if (selectedIds.length === 0) {
        return alert('Сначала выберите галочкой хотя бы один вопрос для удаления!');
    }
    
    if (!confirm(`Вы действительно хотите удалить выбранные вопросы (${selectedIds.length} шт.)? Это действие необратимо!`)) {
        return;
    }

    document.getElementById('questions-list-render').innerHTML = '<h2 style="text-align:center; padding: 50px;">Удаление...</h2>';

    const { error } = await supabaseClient.from('questions').delete().in('id', selectedIds);

    if (error) {
        alert('Ошибка при удалении вопросов');
        console.error(error);
    }

    openSubjectManager(state.activeSubjectKey);
};

// --- НОВАЯ ФУНКЦИЯ ДЛЯ МАССОВОГО РАЗДЕЛЕНИЯ ВОПРОСОВ НА ЧАСТИ ---
window.splitQuestionsIntoParts = async function() {
    if (state.adminQuestions.length === 0) {
        return alert("В этом предмете нет вопросов для разделения.");
    }

    const numPartsStr = prompt(`У вас ${state.adminQuestions.length} вопросов.\nНа сколько равных частей вы хотите их разделить? (введите число, например, 3)`);
    if (!numPartsStr) return;

    const numParts = parseInt(numPartsStr, 10);
    if (isNaN(numParts) || numParts < 2) {
        return alert("Пожалуйста, введите число больше 1.");
    }

    if (numParts > state.adminQuestions.length) {
        return alert("Количество частей не может быть больше количества вопросов!");
    }

    document.getElementById('questions-list-render').innerHTML = '<h2 style="text-align:center; padding: 50px;">⏳ Разделение на части...</h2>';

    const chunkSize = Math.ceil(state.adminQuestions.length / numParts);
    
    // Подготавливаем запросы на обновление
    const promises = state.adminQuestions.map((q, index) => {
        const partNum = Math.floor(index / chunkSize) + 1;
        const newPartName = `Часть ${partNum}`;
        
        // Обновляем только те, у которых имя отличается
        if (q.part_name !== newPartName) {
            return supabaseClient.from('questions').update({ part_name: newPartName }).eq('id', q.id);
        }
        return Promise.resolve();
    });

    try {
        await Promise.all(promises);
        alert(`Все вопросы успешно разделены на ${numParts} частей!`);
    } catch (e) {
        console.error(e);
        alert('Произошла ошибка при разделении.');
    }

    // Обновляем список вопросов
    openSubjectManager(state.activeSubjectKey);
};


function renderSubjectQuestionsList() {
  const isSuperadmin = state.currentUser.role === 'superadmin';
  document.getElementById('subject-editor-title').innerText = `Вопросы: ${getTestTitle(state.activeSubjectKey)} (${state.adminQuestions.length})`;
  
  let html = '';
  if (isSuperadmin) {
    html += `
      <div class="card" style="box-shadow:none; border:2px dashed #d7dce3; margin-bottom:20px; background:#f8fafc;">
          <h3 style="margin-top:0;">⚡ Быстрый импорт вопросов</h3>
          <div class="muted" style="margin-bottom:10px; font-size:12px;">Вставьте текст. Каждый вопрос должен начинаться с <b>+++++</b>, а варианты ответов с <b>====</b>. Правильный ответ помечается как <b>====#</b></div>
          <input id="import-part-name" type="text" placeholder="Название части (по умолчанию: Основная часть)" value="Основная часть" style="width:100%; padding:8px; border-radius:8px; border:1px solid #ccc; margin-bottom:10px; font-family:inherit;">
          <textarea id="import-text" style="width:100%; height:100px; padding:10px; border-radius:8px; border:1px solid #ccc; font-family:monospace;" placeholder="+++++ Вопрос 1...\n==== Неверный\n====# Верный..."></textarea>
          <button id="import-btn" class="btn-ok" style="margin-top:10px; width:auto; padding:8px 20px;" onclick="parseAndImportQuestions()">Импортировать вопросы</button>
      </div>
      
      <div style="margin-bottom: 15px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
          <button class="btn-primary" style="margin:0; width:auto; padding:10px 20px;" onclick="openQuestionEditor(null)">+ Создать 1 вопрос вручную</button>
          <button class="btn-gray" style="margin:0; width:auto; padding:10px 20px; border: 1px solid #000;" onclick="splitQuestionsIntoParts()">✂️ Разделить на части</button>
          <button class="btn-bad" style="margin:0; width:auto; padding:10px 20px;" onclick="deleteSelectedQuestions()">🗑 Удалить выбранные</button>
          
          <label style="cursor:pointer; display:flex; align-items:center; gap:8px; margin-left: auto; font-size:14px; background: #f1f5f9; padding: 8px 15px; border-radius: 8px; border: 1px solid #cbd5e1;">
              <input type="checkbox" id="select-all-questions" style="margin:0; width:16px; height:16px;" onchange="toggleAllQuestions(this)">
              <b>Выбрать все вопросы</b>
          </label>
      </div>
    `;
  }

  if (state.adminQuestions.length === 0) {
    html += `<div class="muted">Вопросов пока нет. Добавьте вручную или через импорт.</div>`;
  } else {
    state.adminQuestions.forEach((q, index) => {
      let answersHtml = q.a.map((ans, i) => `<div style="font-size:14px; margin-top:4px; ${i === q.c ? 'color:green; font-weight:bold;' : 'color:#555;'}">${i === q.c ? '✅' : '➖'} ${escapeHtml(ans)}</div>`).join('');
      let partBadge = q.part_name && q.part_name !== 'Основная часть' ? `<span style="background:#e2e8f0; padding:2px 6px; border-radius:4px; font-size:12px; color:#475569; margin-bottom:8px; display:inline-block;">Модуль: ${escapeHtml(q.part_name)}</span>` : '';

      html += `
        <div class="card" style="margin-top: 10px; padding: 15px; box-shadow: none; border: 1px solid #d7dce3; position: relative;">
          ${isSuperadmin ? `<input type="checkbox" class="question-checkbox" value="${q.id}" style="position: absolute; top: 15px; right: 15px; width: 18px; height: 18px; cursor: pointer;">` : ''}
          ${partBadge}
          <div style="font-weight: bold; font-size: 16px; margin-bottom: 8px; padding-right: 30px;">${index + 1}. ${escapeHtml(q.q)}</div>
          <div>${answersHtml}</div>
          ${isSuperadmin ? `
            <div style="margin-top: 12px; display:flex; gap:10px;">
              <button class="btn-gray" style="padding:8px; width:auto; font-size:13px;" onclick="openQuestionEditor(${q.id})">✏️ Редактировать</button>
              <button class="btn-bad" style="padding:8px; width:auto; font-size:13px;" onclick="deleteQuestion(${q.id})">❌ Удалить</button>
            </div>
          ` : ''}
        </div>
      `;
    });
  }

  document.getElementById('questions-list-render').innerHTML = html;
  document.getElementById('question-form-container').classList.add('hidden');
  document.getElementById('questions-list-render').classList.remove('hidden');
}

function openQuestionEditor(id) {
  state.editingQuestionId = id;
  document.getElementById('questions-list-render').classList.add('hidden');
  const formContainer = document.getElementById('question-form-container');
  formContainer.classList.remove('hidden');

  let qText = '';
  let answers = ['', ''];
  let correctIdx = 0;
  let qPart = 'Основная часть';

  if (id) {
    const qObj = state.adminQuestions.find(q => q.id === id);
    if (qObj) {
      qText = qObj.q;
      answers = [...qObj.a];
      correctIdx = qObj.c;
      qPart = qObj.part_name || 'Основная часть';
    }
  }

  formContainer.innerHTML = `
    <div class="card" style="box-shadow: none; border: 2px solid var(--primary); margin-top:0;">
      <h3 style="margin-top:0;">${id ? 'Редактирование вопроса' : 'Новый вопрос'}</h3>
      
      <label><strong>Часть/Модуль:</strong></label>
      <input id="edit-q-part" type="text" value="${escapeHtml(qPart)}" style="width:100%; padding:8px; margin-top:5px; margin-bottom:15px; border-radius:8px; border:1px solid #ccc; font-family:inherit;">

      <label><strong>Текст вопроса:</strong></label>
      <textarea id="edit-q-text" style="width:100%; height:80px; padding:10px; margin-top:5px; border-radius:8px; border:1px solid #ccc; font-family:inherit;">${escapeHtml(qText)}</textarea>
      
      <div style="margin-top:15px;"><strong>Варианты ответа (отметьте правильный):</strong></div>
      <div id="edit-answers-list"></div>
      
      <button class="btn-gray" style="margin-top:10px; width:auto; padding:8px 15px;" onclick="addAnswerField()">+ Добавить вариант</button>
      
      <div style="margin-top: 20px; display:flex; gap:10px;">
        <button class="btn-ok" onclick="saveQuestion()">Сохранить</button>
        <button class="btn-gray" onclick="cancelQuestionEdit()">Отмена</button>
      </div>
    </div>
  `;

  window._tempAnswers = answers;
  window._tempCorrect = correctIdx;
  renderAnswerFields();
}

function renderAnswerFields() {
  const container = document.getElementById('edit-answers-list');
  container.innerHTML = window._tempAnswers.map((ans, i) => `
    <div style="display:flex; align-items:center; gap:10px; margin-top:8px;">
      <input type="radio" name="correct_answer" value="${i}" ${i === window._tempCorrect ? 'checked' : ''} style="width:20px; height:20px; margin:0;" onchange="window._tempCorrect = ${i}">
      <input type="text" class="edit-ans-input" value="${escapeHtml(ans)}" placeholder="Вариант ответа" style="margin:0; flex:1;" onchange="window._tempAnswers[${i}] = this.value">
      <button class="btn-bad" style="width:auto; padding:8px; margin:0;" onclick="removeAnswerField(${i})">X</button>
    </div>
  `).join('');
}

window.addAnswerField = function() {
  window._tempAnswers.push('');
  renderAnswerFields();
};

window.removeAnswerField = function(idx) {
  if (window._tempAnswers.length <= 2) { alert('Минимум 2 варианта ответа!'); return; }
  window._tempAnswers.splice(idx, 1);
  if (window._tempCorrect >= window._tempAnswers.length) window._tempCorrect = 0;
  renderAnswerFields();
};

window.cancelQuestionEdit = function() {
  document.getElementById('question-form-container').classList.add('hidden');
  document.getElementById('questions-list-render').classList.remove('hidden');
};

window.saveQuestion = async function() {
  const qPart = document.getElementById('edit-q-part').value.trim() || 'Основная часть';
  const qText = document.getElementById('edit-q-text').value.trim();
  const inputs = document.querySelectorAll('.edit-ans-input');
  const answers = Array.from(inputs).map(inp => inp.value.trim());
  
  if (!qText) { alert('Введите текст вопроса!'); return; }
  if (answers.some(a => !a)) { alert('Заполните все варианты ответов!'); return; }

  const payload = {
    test_key: state.activeSubjectKey,
    part_name: qPart,
    q: qText,
    a: answers,
    c: window._tempCorrect
  };

  document.getElementById('question-form-container').innerHTML = '<h3>Сохранение...</h3>';

  if (state.editingQuestionId) {
    const { error } = await supabaseClient.from('questions').update(payload).eq('id', state.editingQuestionId);
    if (error) { alert('Ошибка сохранения'); console.error(error); }
  } else {
    const { error } = await supabaseClient.from('questions').insert([payload]);
    if (error) { alert('Ошибка создания'); console.error(error); }
  }
  
  openSubjectManager(state.activeSubjectKey);
};

window.deleteQuestion = async function(id) {
  if (!confirm('Точно удалить этот вопрос?')) return;
  const { error } = await supabaseClient.from('questions').delete().eq('id', id);
  if (error) { alert('Ошибка удаления'); console.error(error); }
  else { openSubjectManager(state.activeSubjectKey); }
};

window.banIP = async function(ip) {
  if (!ip || ip === 'Скрыт/VPN') { alert('Невозможно заблокировать скрытый IP.'); return; }
  if (!confirm(`Точно заблокировать доступ для IP: ${ip} ?`)) return;
  
  const { error } = await supabaseClient.from('banned_ips').insert([{ ip_address: ip }]);
  if (error) { alert('Ошибка (возможно IP уже в бане)'); }
  else { alert('IP успешно заблокирован!'); openAdminPanel(); }
};

window.unbanIP = async function(id) {
  if (!confirm('Снять блокировку с этого IP?')) return;
  await supabaseClient.from('banned_ips').delete().eq('id', id);
  openAdminPanel();
};

function renderAdminPanel(users = [], results = [], accesses = [], history = [], bannedIps = [], groups = []) {
  state.adminUsers = users;
  state.adminGroups = groups;
  
  showScreen('screen-admin');
  const isSuperadmin = state.currentUser.role === 'superadmin';

  const subjectsGrid = Object.keys(TEST_TITLES).map(key => `
    <div class="card" style="box-shadow:none; border:1px solid #d7dce3; margin-top:10px; display:flex; justify-content:space-between; align-items:center; padding:15px;">
      <div>
        <div style="font-weight:bold; font-size:16px;">${escapeHtml(TEST_TITLES[key])}</div>
        <div style="font-size:12px; color:#888; margin-top:4px;">Ключ: ${escapeHtml(key)}</div>
      </div>
      <button class="btn-primary" style="width:auto; padding:10px 20px; margin:0;" onclick="openSubjectManager('${key}')">Управление</button>
    </div>
  `).join('');

  const groupsRows = groups.length ? groups.map(g => `
      <tr>
        <td>${escapeHtml(g.name)}</td>
        <td>
            <button class="btn-ok" style="padding:6px 12px; width:auto; font-size:12px; margin-right:5px;" onclick="openGroupManager('${escapeHtml(g.name)}')">👥 Состав группы</button>
            <button class="btn-bad" style="padding:6px 12px; width:auto; font-size:12px;" onclick="deleteGroup(${g.id}, '${escapeHtml(g.name)}')">❌ Удалить</button>
        </td>
      </tr>
  `).join('') : `<tr><td colspan="2">Групп пока нет</td></tr>`;

  const visibleUsers = isSuperadmin 
    ? users 
    : users.filter(u => u.role === 'student' || u.username === state.currentUser.username);

  const userRows = visibleUsers.length ? visibleUsers.map(user => {
    let canDelete = false;
    if (isSuperadmin && user.username !== state.currentUser.username) canDelete = true;
    else if (!isSuperadmin && user.role === 'student') canDelete = true;
    return `
      <tr>
        <td>${escapeHtml(user.id)}</td>
        <td>${escapeHtml(user.username)}</td>
        <td>${escapeHtml(user.password)}</td>
        <td>${escapeHtml(user.role)}</td>
        <td>${escapeHtml(user.group_name || 'Без группы')}</td>
        <td>${canDelete ? `<button class="btn-bad" style="padding:10px; width:auto;" onclick="deleteUser(${user.id})">❌</button>` : ''}</td>
      </tr>
    `;
  }).join('') : `<tr><td colspan="6">Пользователей пока нет</td></tr>`;

  let roleOptions = `<option value="student">student (Студент)</option>`;
  if (isSuperadmin) {
    roleOptions += `<option value="admin">admin (Обычный Админ)</option><option value="superadmin">superadmin (Главный Админ)</option>`;
  }
  
  const groupSelectOptions = `<option value="Без группы">Без группы</option>` + groups.map(g => `<option value="${escapeHtml(g.name)}">${escapeHtml(g.name)}</option>`).join('');

  const accessRows = accesses.length ? accesses.map(row => `
      <tr class="access-row" data-filter-key="${row.test_key}">
        <td>${escapeHtml(row.username)}</td>
        <td>${escapeHtml(getTestTitle(row.test_key))}</td>
        <td>${new Date(row.start_time).toLocaleString()}</td>
        <td>${new Date(row.end_time).toLocaleString()}</td>
        <td><button class="btn-bad" style="padding:10px; width:auto;" onclick="deleteAccess(${row.id})">❌</button></td>
      </tr>
    `).join('') : `<tr><td colspan="5">Нет активных доступов</td></tr>`;

  const completedResults = results.filter(r => r.status !== 'incomplete');
  const incompleteResults = results.filter(r => r.status === 'incomplete');

  const resultRows = completedResults.length ? completedResults.map(row => {
      const baseNameMatch = row.test_name.match(/^(.*?) \(/);
      const baseName = baseNameMatch ? baseNameMatch[1] : row.test_name;
      const testKey = Object.keys(TEST_TITLES).find(k => TEST_TITLES[k] === baseName) || 'unknown';
      
      return `
      <tr class="result-row" data-filter-key="${testKey}">
        <td>${escapeHtml(row.id)}</td>
        <td>${escapeHtml(row.username)}</td>
        <td>${escapeHtml(row.test_name)}</td>
        <td>${escapeHtml(row.score)}/${escapeHtml(row.total)}</td>
        <td>${escapeHtml(row.percentage)}%</td>
        <td><button class="btn-bad" style="padding:10px; width:auto;" onclick="deleteResult(${row.id})">❌</button></td>
      </tr>
    `}).join('') : `<tr><td colspan="6">Завершенных результатов пока нет</td></tr>`;

  const incompleteRows = incompleteResults.length ? incompleteResults.map(row => {
      const baseNameMatch = row.test_name.match(/^(.*?) \(/);
      const baseName = baseNameMatch ? baseNameMatch[1] : row.test_name;
      const testKey = Object.keys(TEST_TITLES).find(k => TEST_TITLES[k] === baseName) || 'unknown';
      
      return `
      <tr class="incomplete-row" data-filter-key="${testKey}">
        <td>${escapeHtml(row.id)}</td>
        <td>${escapeHtml(row.username)}</td>
        <td>${escapeHtml(row.test_name)}</td>
        <td>${escapeHtml(row.score)} (до выхода)</td>
        <td><button class="btn-bad" style="padding:10px; width:auto;" onclick="deleteResult(${row.id})">❌</button></td>
      </tr>
    `}).join('') : `<tr><td colspan="5">Незавершенных тестов нет</td></tr>`;

  const visibleHistory = isSuperadmin 
    ? history 
    : history.filter(h => {
        const u = users.find(user => user.username === h.username);
        if (!u) return true;
        return u.role === 'student' || h.username === state.currentUser.username;
    });

  const historyRows = visibleHistory.length ? visibleHistory.map(row => {
    let banBtn = '';
    if (isSuperadmin && row.ip_address !== 'Скрыт/VPN') banBtn = `<button class="btn-bad" style="padding:4px 8px; font-size:12px; margin-left:10px; width:auto;" onclick="banIP('${escapeHtml(row.ip_address)}')">⛔ Бан</button>`;
    return `<tr class="history-row" data-filter-key="${escapeHtml(row.username)}"><td>${escapeHtml(row.username)}</td><td>${escapeHtml(row.ip_address)} ${banBtn}</td><td>${new Date(row.login_time).toLocaleString()}</td></tr>`;
  }).join('') : `<tr><td colspan="3">Истории входов пока нет</td></tr>`;

  const bannedRows = bannedIps.length ? bannedIps.map(row => `<tr><td style="color:red; font-weight:bold;">${escapeHtml(row.ip_address)}</td><td>${new Date(row.banned_at).toLocaleString()}</td><td><button class="btn-ok" style="padding:8px 15px; width:auto;" onclick="unbanIP(${row.id})">Разблокировать</button></td></tr>`).join('') : `<tr><td colspan="3">Черный список пуст</td></tr>`;

  const uniqueUsers = [...new Set(visibleHistory.map(u => u.username))];
  const historyUserOptions = uniqueUsers.map(u => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join('');

  screenAdmin.innerHTML = `
    <div class="screen-top">
      <div class="left">
        <h1 class="title-left">Админ-панель</h1>
        <div class="subtitle-left">Статус: ${isSuperadmin ? 'Главный Администратор' : 'Администратор'} | ${escapeHtml(state.currentUser.username)}</div>
      </div>
      <div class="right">
        <button class="btn-gray" onclick="openAdminPanel()">🔄 Обновить</button>
        <button class="btn-gray" onclick="changeMyPassword()">🔑 Пароль</button>
        <button class="btn-bad" onclick="logout()">🚪 Выйти</button>
      </div>
    </div>
    
    <div class="admin-tabs" style="display:flex; flex-wrap:wrap;">
      <button id="btn-subjects" class="tab-btn" onclick="switchAdminTab('subjects')">Предметы</button>
      <button id="btn-students" class="tab-btn" onclick="switchAdminTab('students')">Пользователи</button>
      <button id="btn-exams" class="tab-btn" onclick="switchAdminTab('exams')">Экзамены</button>
      <button id="btn-results" class="tab-btn" onclick="switchAdminTab('results')">Результаты</button>
      <button id="btn-incomplete" class="tab-btn" onclick="switchAdminTab('incomplete')">Незавершенные</button>
      <button id="btn-history" class="tab-btn" onclick="switchAdminTab('history')">История</button>
      ${isSuperadmin ? `<button id="btn-blacklist" class="tab-btn" style="color: red;" onclick="switchAdminTab('blacklist')">Бан-лист</button>` : ''}
    </div>
    
    <div id="tab-subjects" class="tab-content admin-section">
      <div id="subjects-list-container">
        <h2>Список предметов</h2>
        <div style="margin-top:15px;">${subjectsGrid}</div>
      </div>
      <div id="subject-editor-container" class="hidden">
        <button class="btn-gray" style="margin-bottom:15px; width:auto; padding: 10px 20px;" onclick="closeSubjectManager()">🔙 Назад к списку</button>
        <h2 id="subject-editor-title" style="text-align:left;">Управление вопросами</h2>
        <div id="question-form-container" class="hidden"></div>
        <div id="questions-list-render"></div>
      </div>
    </div>
    
    <div id="tab-students" class="tab-content admin-section">
      <div id="students-main-view">
          <h2>Управление группами</h2>
          <div style="display:flex; gap:10px; margin-bottom: 15px;">
              <input id="new-group-input" placeholder="Название новой группы" style="margin:0;" />
              <button class="btn-ok" style="margin:0; width:auto; padding: 0 20px;" onclick="createGroup()">Добавить</button>
          </div>
          <div class="table-wrap"><table><tr><th>Группа</th><th>Действия</th></tr>${groupsRows}</table></div>
          
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
          
          <div class="card" style="box-shadow:none; margin-top:0; padding:0; margin-bottom: 20px;">
            <h2>Создать пользователя</h2>
            <input id="new-username" placeholder="Логин" autocomplete="off" />
            <input id="new-password" placeholder="Пароль" autocomplete="off" />
            <select id="new-role" onchange="document.getElementById('group-container').style.display = this.value === 'student' ? 'block' : 'none'">${roleOptions}</select>
            <div id="group-container" style="margin-top: 10px;">
                <select id="new-group">${groupSelectOptions}</select>
            </div>
            <button class="btn-ok" style="margin-top: 15px;" onclick="createUser()">Создать</button>
          </div>
          
          <h2>Список пользователей</h2>
          <div class="table-wrap"><table><tr><th>ID</th><th>Логин</th><th>Пароль</th><th>Роль</th><th>Группа</th><th>Удалить</th></tr>${userRows}</table></div>
      </div>

      <div id="group-editor-view" class="hidden">
          <button class="btn-gray" style="margin-bottom:15px; width:auto; padding: 10px 20px;" onclick="closeGroupManager()">🔙 Назад</button>
          <h2 id="group-editor-title">Состав группы</h2>
          <div id="group-members-list" class="table-wrap" style="margin-bottom:20px;"></div>
          <div class="card" style="box-shadow:none; border:1px solid #d7dce3;">
              <h3 style="margin-top:0;">Добавить студента в группу</h3>
              <div style="display:flex; gap:10px;">
                  <select id="add-to-group-select" style="margin:0;"></select>
                  <button class="btn-ok" style="margin:0; width:auto; padding:0 20px;" onclick="addUserToGroup()">Добавить</button>
              </div>
          </div>
      </div>
    </div>
    
    <div id="tab-exams" class="tab-content admin-section">
      <div class="card" style="box-shadow:none; margin-top:0; padding:0; margin-bottom: 20px;">
        <h2>Открыть доступ к экзамену</h2>
        <select id="access-test" style="margin-bottom:20px;">${Object.keys(TEST_TITLES).map(key => `<option value="${key}">${escapeHtml(TEST_TITLES[key])}</option>`).join('')}</select>
        
        <div style="display:flex; gap:20px; margin-bottom:15px; background: #f9fafb; padding:10px; border-radius:8px;">
            <label style="cursor:pointer;"><input type="radio" name="access_type" value="group" checked onchange="toggleAccessMode()"> <b>Группе целиком</b></label>
            <label style="cursor:pointer;"><input type="radio" name="access_type" value="individual" onchange="toggleAccessMode()"> <b>Выбрать индивидуально</b></label>
        </div>

        <div id="access-mode-group">
            <select id="access-group-select">${groupSelectOptions}</select>
            <div class="muted">Доступ получат все студенты, состоящие в выбранной группе на данный момент.</div>
        </div>

        <div id="access-mode-individual" class="hidden">
            <div id="students-list" class="students-list" style="max-height: 200px; overflow-y: auto; border: 1px solid #d7dce3; padding: 10px; border-radius: 8px;">Загрузка студентов...</div>
            <div style="margin-top:10px;">
              <button class="btn-gray" style="padding:5px 10px; font-size:12px; width:auto;" onclick="selectAllCheckboxes()">✅ Выбрать всех</button> 
              <button class="btn-gray" style="padding:5px 10px; font-size:12px; width:auto;" onclick="deselectAllCheckboxes()">❌ Снять выделение</button>
            </div>
        </div>
        
        <label style="display:block;margin-top:20px;">Начало доступа</label><input id="access-start" type="datetime-local">
        <label style="display:block;margin-top:15px;">Конец доступа</label><input id="access-end" type="datetime-local">
        <button class="btn-ok" style="margin-top:15px;" onclick="grantAccess()">Открыть доступ</button>
      </div>
      <h2>Активные доступы</h2>
      <select id="filter-access" onchange="filterTableRows('access-row', this.value)" style="margin-bottom: 15px;">
        <option value="all">Все предметы</option>${Object.keys(TEST_TITLES).map(key => `<option value="${key}">${escapeHtml(TEST_TITLES[key])}</option>`).join('')}
      </select>
      <div class="table-wrap"><table><tr><th>Студент</th><th>Предмет</th><th>Начало</th><th>Конец</th><th>Удалить</th></tr>${accessRows}</table></div>
    </div>
    
    <div id="tab-results" class="tab-content admin-section">
      <h2>Результаты тестов</h2>
      <select id="filter-result" onchange="filterTableRows('result-row', this.value)" style="margin-bottom: 15px;">
        <option value="all">Все предметы</option>${Object.keys(TEST_TITLES).map(key => `<option value="${key}">${escapeHtml(TEST_TITLES[key])}</option>`).join('')}
      </select>
      <div class="table-wrap"><table><tr><th>ID</th><th>Пользователь</th><th>Тест</th><th>Баллы</th><th>%</th><th>Удалить</th></tr>${resultRows}</table></div>
    </div>

    <div id="tab-incomplete" class="tab-content admin-section">
      <h2>Незавершенные тесты (Прерванные)</h2>
      <div class="muted" style="margin-bottom:15px;">Здесь показаны тесты, из которых студент вышел с помощью кнопки "Назад".</div>
      <select id="filter-incomplete" onchange="filterTableRows('incomplete-row', this.value)" style="margin-bottom: 15px;">
        <option value="all">Все предметы</option>${Object.keys(TEST_TITLES).map(key => `<option value="${key}">${escapeHtml(TEST_TITLES[key])}</option>`).join('')}
      </select>
      <div class="table-wrap"><table><tr><th>ID</th><th>Пользователь</th><th>Тест</th><th>Баллы на момент выхода</th><th>Удалить</th></tr>${incompleteRows}</table></div>
    </div>

    <div id="tab-history" class="tab-content admin-section">
      <h2>История авторизаций</h2>
      <select id="filter-history" onchange="filterTableRows('history-row', this.value)" style="margin-bottom: 15px;">
        <option value="all">Все пользователи</option>${historyUserOptions}
      </select>
      <div class="table-wrap"><table><tr><th>Пользователь</th><th>IP-адрес</th><th>Время входа</th></tr>${historyRows}</table></div>
    </div>

    ${isSuperadmin ? `
    <div id="tab-blacklist" class="tab-content admin-section">
      <h2 style="color:red;">Черный список IP-адресов</h2>
      <div class="muted" style="margin-bottom: 15px;">Заблокированные устройства не смогут войти в систему под любым логином.</div>
      <div class="table-wrap"><table><tr><th>IP-адрес</th><th>Дата блокировки</th><th>Действие</th></tr>${bannedRows}</table></div>
    </div>
    ` : ''}
  `;
  
  renderStudentsCheckboxes();
  switchAdminTab(currentAdminTab);
  if (state.activeGroupManager) openGroupManager(state.activeGroupManager);
}

window.toggleAccessMode = function() {
    const mode = document.querySelector('input[name="access_type"]:checked').value;
    if (mode === 'group') {
        document.getElementById('access-mode-group').classList.remove('hidden');
        document.getElementById('access-mode-individual').classList.add('hidden');
    } else {
        document.getElementById('access-mode-group').classList.add('hidden');
        document.getElementById('access-mode-individual').classList.remove('hidden');
    }
}

window.renderStudentsCheckboxes = function() {
  const container = document.getElementById('students-list');
  if (!container) return;
  const students = state.adminUsers.filter(u => u.role === 'student');
  let html = '';
  if (!students.length) { 
      html = '<div class="muted" style="margin:0;">Студентов пока нет.</div>'; 
  } else {
      students.forEach(user => {
        const grp = user.group_name && user.group_name !== 'Без группы' ? ` <span style="color:#888; font-size:12px;">[${escapeHtml(user.group_name)}]</span>` : '';
        html += `<label class="student-item" style="display:block; margin-bottom:5px;"><input type="checkbox" value="${escapeHtml(user.username)}" class="student-checkbox"><span>${escapeHtml(user.username)}${grp}</span></label>`;
      });
  }
  container.innerHTML = html;
};

window.selectAllCheckboxes = function() {
  document.querySelectorAll('.student-checkbox').forEach(cb => cb.checked = true);
};

window.deselectAllCheckboxes = function() {
  document.querySelectorAll('.student-checkbox').forEach(cb => cb.checked = false);
};

async function startTest(testKey, mode, partName = null) {
  document.getElementById('screen-selection').innerHTML = '<h2 style="margin-top:50px; text-align:center;">⏳ Загрузка вопросов...</h2>';
  
  const { data: qData, error: qError } = await supabaseClient.from('questions').select('*').eq('test_key', testKey);
  if (qError || !qData || qData.length === 0) { alert('Вопросы не найдены!'); renderSelection(); return; }
  
  const { data: sData } = await supabaseClient.from('student_q_state')
     .select('*').eq('username', state.currentUser.username).eq('test_key', testKey);
     
  state.qStates = {};
  (sData || []).forEach(row => {
      state.qStates[row.question_id] = { id: row.id, is_correct: row.is_correct, is_favorite: row.is_favorite };
  });

  let filteredQs = qData;
  if (mode === 'part' && partName) {
      filteredQs = qData.filter(q => (q.part_name || 'Основная часть') === partName);
      if (!filteredQs.length) { alert('В этой части нет вопросов!'); renderSelection(); return; }
  } else if (mode === 'wrong') {
      filteredQs = qData.filter(q => {
          const st = state.qStates[q.id];
          return st && st.is_correct === false;
      });
      if (!filteredQs.length) { alert('Отличная работа! У вас нет ошибок в этом предмете. 🎉'); renderSelection(); return; }
  } else if (mode === 'favorite') {
      filteredQs = qData.filter(q => {
          const st = state.qStates[q.id];
          return st && st.is_favorite === true;
      });
      if (!filteredQs.length) { alert('Вы еще не добавили ни одного вопроса в избранное!'); renderSelection(); return; }
  }

  state.currentTestKey = testKey;
  state.currentPartName = partName; 
  state.questions = shuffleArray(filteredQs.map(cloneQuestion));
  state.currentIndex = 0;
  state.score = 0;
  state.wrongQuestions = [];
  state.isRepeatMode = (mode !== 'part'); 
  
  saveTestProgress(false); 
  renderQuizShell();
  loadQuestion();
}

window.toggleFavorite = function() {
    const q = state.questions[state.currentIndex];
    let st = state.qStates[q.id] || { is_correct: null, is_favorite: false };
    st.is_favorite = !st.is_favorite; 
    state.qStates[q.id] = st;
    
    const btn = document.getElementById('btn-favorite');
    btn.style.color = st.is_favorite ? '#f59e0b' : '#cbd5e1';
    
    saveQState(q.id, st.is_correct, st.is_favorite);
    saveTestProgress(); 
};

window.saveQState = async function(qId, isCorrect, isFavorite) {
    const st = state.qStates[qId];
    const payload = { 
        username: state.currentUser.username, 
        test_key: state.currentTestKey, 
        question_id: qId, 
        is_correct: isCorrect, 
        is_favorite: !!isFavorite
    };
    
    if (st && st.id) {
        await supabaseClient.from('student_q_state').update(payload).eq('id', st.id);
    } else {
        const { data } = await supabaseClient.from('student_q_state').insert([payload]).select().single();
        if (data) state.qStates[qId] = data; 
    }
};

function loadQuestion() {
  if (!state.questions.length) { finishQuiz(); return; }
  saveTestProgress(false); 

  const q = state.questions[state.currentIndex];
  const total = state.questions.length;
  const st = state.qStates[q.id] || { is_favorite: false };

  document.getElementById('quiz-title').innerText = getTestTitle(state.currentTestKey);
  if (state.currentPartName && state.currentPartName !== 'Основная часть') {
      document.getElementById('quiz-title').innerHTML += ` <span style="font-size:16px; color:#888;">(${escapeHtml(state.currentPartName)})</span>`;
  }
  
  document.getElementById('counter').innerText = `Вопрос ${state.currentIndex + 1} из ${total}`;
  document.getElementById('progress-bar').style.width = `${(state.currentIndex / total) * 100}%`;
  
  const starColor = st.is_favorite ? '#f59e0b' : '#cbd5e1';
  document.getElementById('question').innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:flex-start;">
          <div>${escapeHtml(q.q)}</div>
          <button id="btn-favorite" onclick="toggleFavorite()" style="background:none; border:none; font-size:28px; cursor:pointer; padding:0; margin-left:15px; outline:none; color:${starColor};" title="Добавить в избранное">
              ★
          </button>
      </div>
  `;

  const options = document.getElementById('options');
  options.innerHTML = '';
  const shuffledOptions = shuffleArray(q.a.map((text, idx) => ({ text, correct: idx === q.c })));

  shuffledOptions.forEach(item => {
    const btn = document.createElement('button');
    btn.className = 'option';
    btn.type = 'button';
    btn.textContent = item.text;
    btn.dataset.correct = item.correct ? '1' : '0';
    btn.addEventListener('click', () => selectAnswer(btn, item.correct));
    options.appendChild(btn);
  });
  document.getElementById('next-btn').classList.add('hidden');
}

function selectAnswer(selectedBtn, isCorrect) {
  const buttons = document.querySelectorAll('#options .option');
  buttons.forEach(btn => btn.disabled = true);
  buttons.forEach(btn => { if (btn.dataset.correct === '1') btn.classList.add('correct'); });

  if (!isCorrect) {
    selectedBtn.classList.add('wrong');
    if (!state.isRepeatMode) state.wrongQuestions.push(cloneQuestion(state.questions[state.currentIndex]));
  } else state.score++;

  const qId = state.questions[state.currentIndex].id;
  let st = state.qStates[qId] || { is_correct: null, is_favorite: false };
  st.is_correct = isCorrect;
  state.qStates[qId] = st;
  saveQState(qId, isCorrect, st.is_favorite);

  saveTestProgress(true); 
  document.getElementById('next-btn').classList.remove('hidden');
}

function nextQuestion() {
  state.currentIndex++;
  if (state.currentIndex < state.questions.length) loadQuestion();
  else finishQuiz();
}

async function saveResult(status = 'completed') {
  const total = state.questions.length || 1;
  const percentage = Number(((state.score / total) * 100).toFixed(2));
  
  let testName = getTestTitle(state.currentTestKey);
  if (state.currentPartName && state.currentPartName !== 'Основная часть') {
      testName += ` (${state.currentPartName})`;
  }

  await supabaseClient.from('results').insert([{ 
      username: state.currentUser.username, 
      test_name: testName, 
      score: state.score, 
      total: state.questions.length, 
      percentage: percentage,
      status: status
  }]);
}

async function finishQuiz() {
  clearTestProgress(); 
  if (!state.isRepeatMode) await saveResult('completed');
  renderResult();
}

function repeatWrong() {
  state.isRepeatMode = true;
  state.questions = shuffleArray(state.wrongQuestions.map(cloneQuestion));
  state.currentIndex = 0;
  state.score = 0;
  saveTestProgress(false);
  renderQuizShell();
  loadQuestion();
}

function backToSelection() {
  state.currentTestKey = null;
  state.currentPartName = null;
  state.questions = [];
  state.currentIndex = 0;
  state.score = 0;
  clearTestProgress();
  renderSelection();
}

function logout(force = false) {
  if (!force && !confirm('Вы уверены, что хотите выйти из системы?')) return;
  if (sessionCheckInterval) clearInterval(sessionCheckInterval);
  clearSavedUser();
  clearTestProgress();
  state.currentUser = null;
  state.currentTestKey = null;
  state.currentPartName = null;
  state.questions = [];
  state.currentIndex = 0;
  state.score = 0;
  state.wrongQuestions = [];
  state.isRepeatMode = false;
  renderLogin();
}

async function grantAccess() {
  const testKey = document.getElementById('access-test').value;
  const startRaw = document.getElementById('access-start').value;
  const endRaw = document.getElementById('access-end').value;

  if (!startRaw || !endRaw) { alert('Заполните поля даты и времени'); return; }

  const mode = document.querySelector('input[name="access_type"]:checked').value;
  let usernames = [];

  if (mode === 'group') {
      const selectedGroup = document.getElementById('access-group-select').value;
      const usersInGroup = state.adminUsers.filter(u => u.role === 'student' && u.group_name === selectedGroup);
      usernames = usersInGroup.map(u => u.username);
      if(usernames.length === 0) return alert('В выбранной группе нет студентов!');
  } else {
      usernames = [...document.querySelectorAll('.student-checkbox:checked')].map(cb => cb.value);
      if(usernames.length === 0) return alert('Выберите хотя бы одного студента');
  }

  const start = new Date(startRaw).toISOString();
  const end = new Date(endRaw).toISOString();

  for (const username of usernames) {
    await supabaseClient.from('test_access').delete().eq('username', username).eq('test_key', testKey);
    await supabaseClient.from('test_access').insert([{ username, test_key: testKey, start_time: start, end_time: end, is_active: true }]);
  }
  alert(`Доступ успешно открыт для ${usernames.length} студентов`);
  await openAdminPanel();
}

async function createUser() {
  const username = document.getElementById('new-username').value.trim();
  const password = document.getElementById('new-password').value.trim();
  const role = document.getElementById('new-role').value;
  
  let groupName = 'Без группы';
  if (role === 'student') {
      groupName = document.getElementById('new-group').value;
  }

  if (!username || !password) { alert('Заполните логин и пароль'); return; }
  const { error } = await supabaseClient.from('users').insert([{ username, password, role, group_name: groupName }]);
  if (error) alert('Ошибка создания пользователя (возможно логин занят)');
  else { alert('Пользователь создан'); await openAdminPanel(); }
}

async function deleteUser(id) {
  if (!confirm('Удалить пользователя?')) return;
  await supabaseClient.from('users').delete().eq('id', id);
  await openAdminPanel();
}

async function deleteAccess(id) {
  if (!confirm('Удалить доступ?')) return;
  await supabaseClient.from('test_access').delete().eq('id', id);
  await openAdminPanel();
}

async function deleteResult(id) {
  if (!confirm('Удалить результат?')) return;
  await supabaseClient.from('results').delete().eq('id', id);
  await openAdminPanel();
}

async function openAdminPanel() {
  showScreen('screen-admin');
  const now = new Date().toISOString();
  await supabaseClient.from('test_access').delete().lt('end_time', now);

  const [usersRes, resultsRes, accessRes, historyRes, bannedRes, groupsRes] = await Promise.all([
    supabaseClient.from('users').select('*').order('id', { ascending: true }),
    supabaseClient.from('results').select('*').order('id', { ascending: false }),
    supabaseClient.from('test_access').select('*').gte('end_time', now).order('id', { ascending: false }),
    supabaseClient.from('login_history').select('*').order('login_time', { ascending: false }).limit(200),
    supabaseClient.from('banned_ips').select('*').order('banned_at', { ascending: false }),
    supabaseClient.from('groups').select('*').order('name', { ascending: true })
  ]);

  renderAdminPanel(
    usersRes.data || [], 
    resultsRes.data || [], 
    accessRes.data || [], 
    historyRes.data || [],
    bannedRes.data || [],
    groupsRes.data || []
  );
}

function filterTableRows(rowClassName, selectedKey) {
  document.querySelectorAll('.' + rowClassName).forEach(row => {
    row.style.display = (selectedKey === 'all' || row.dataset.filterKey === selectedKey) ? '' : 'none';
  });
}

function init() {
  if (typeof supabase === 'undefined') {
      const loginScreen = document.getElementById('screen-login');
      if(loginScreen) {
          loginScreen.classList.remove('hidden');
          loginScreen.innerHTML = '<h2 style="color:#dc3545; padding:30px; text-align:center;">❌ Ошибка: База данных не загрузилась.</h2>';
      }
      return;
  }

  const savedUserStr = localStorage.getItem('user');
  if (savedUserStr) {
    try {
      const parsed = JSON.parse(savedUserStr);
      
      if (parsed.loginTimestamp && (Date.now() - parsed.loginTimestamp > SESSION_LIMIT_MS)) {
          localStorage.removeItem('user');
          clearTestProgress();
          alert('Время сессии (5 часов) истекло. Пожалуйста, войдите заново.');
          renderLogin();
          return;
      }

      state.currentUser = parsed;
      if (sessionCheckInterval) clearInterval(sessionCheckInterval);
      sessionCheckInterval = setInterval(securityCheck, 15000);

      if (parsed.role === 'admin' || parsed.role === 'superadmin') {
          openAdminPanel();
      } else {
          const savedProgressStr = localStorage.getItem('test_progress');
          if (savedProgressStr) {
              try {
                  const prog = JSON.parse(savedProgressStr);
                  state.currentTestKey = prog.currentTestKey;
                  state.currentPartName = prog.currentPartName || null;
                  state.questions = prog.questions;
                  state.currentIndex = prog.currentIndex;
                  state.score = prog.score;
                  state.wrongQuestions = prog.wrongQuestions;
                  state.isRepeatMode = prog.isRepeatMode;
                  state.qStates = prog.qStates || {};

                  if (state.currentIndex >= state.questions.length) {
                      finishQuiz();
                  } else {
                      renderQuizShell();
                      loadQuestion();
                  }
                  return;
              } catch (e) {
                  clearTestProgress();
              }
          }
          renderSelection();
      }
      return;
    } catch (e) { localStorage.removeItem('user'); }
  }
  renderLogin();
}

init();
