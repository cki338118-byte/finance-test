const SUPABASE_URL = 'https://enthswnpuhvmxyjfltms.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVudGhzd25wdWh2bXh5amZsdG1zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzNDA3MzcsImV4cCI6MjA5MzkxNjczN30.2KNWdop3LP5RwDqNuK_ZDnWQAoyKQ-gJQ0Z0FXc6XPY';

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const screenLogin = document.getElementById('screen-login');
const screenSelection = document.getElementById('screen-selection');
const screenQuiz = document.getElementById('screen-quiz');
const screenResult = document.getElementById('screen-result');
const screenAdmin = document.getElementById('screen-admin');

let currentAdminTab = 'subjects';

const TEST_TITLES = {
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
  questions: [],
  currentIndex: 0,
  score: 0,
  wrongQuestions: [],
  isRepeatMode: false
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function cloneQuestion(q) {
  return { q: q.q, a: Array.isArray(q.a) ? [...q.a] : [], c: q.c };
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
  screens.forEach(s => s.classList.add('hidden'));
  document.getElementById(activeId).classList.remove('hidden');
}

function setSavedUser(user) {
  localStorage.setItem('user', JSON.stringify(user));
}

function clearSavedUser() {
  localStorage.removeItem('user');
}

function getTestTitle(key) {
  return TEST_TITLES[key] || 'Тест';
}

function renderLogin() {
  showScreen('screen-login');

  screenLogin.innerHTML = `
    <h1>Вход в систему</h1>
    <div class="muted">Введите логин и пароль</div>
    <input id="username" placeholder="Логин" autocomplete="username" />
    <input id="password" type="password" placeholder="Пароль" autocomplete="current-password" />
    <button id="login-btn" class="btn-ok">Войти</button>
    <div class="small-note">Если у вас уже есть аккаунт, вход сохранится после обновления страницы.</div>
  `;

  document.getElementById('login-btn').addEventListener('click', handleLogin);
  document.getElementById('password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleLogin();
  });
}

async function changeMyPassword() {
  const newPassword = prompt('Введите новый пароль (оставьте пустым для отмены):');
  if (!newPassword || newPassword.trim() === '') return;

  const { error } = await supabaseClient
    .from('users')
    .update({ password: newPassword.trim() })
    .eq('id', state.currentUser.id);

  if (error) {
    alert('Ошибка при смене пароля. Попробуйте еще раз.');
    console.error(error);
  } else {
    alert('Пароль успешно изменен!');
    state.currentUser.password = newPassword.trim();
    setSavedUser(state.currentUser);
    
    if (state.currentUser.role === 'admin') openAdminPanel();
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

  if (error) {
    console.log(error);
    screenSelection.innerHTML = `<h1>Ошибка доступа</h1>`;
    return;
  }

  let html = `
    <div class="screen-top">
      <div class="left">
        <h1 class="title-left">Доступные тесты</h1>
        <div class="subtitle-left">Пользователь: ${escapeHtml(state.currentUser.username)}</div>
      </div>
      <div class="right">
        <button class="btn-gray" onclick="changeMyPassword()">🔑 Пароль</button>
        <button class="btn-bad" onclick="logout()">🚪 Выйти</button>
      </div>
    </div>
  `;

  if (!data.length) {
    html += `<div class="muted">Сейчас вам недоступны тесты</div>`;
  } else {
    html += `<div class="grid">`;
    data.forEach(test => {
      html += `<button onclick="startTest('${test.test_key}')">${getTestTitle(test.test_key)}</button>`;
    });
    html += `</div>`;
  }

  screenSelection.innerHTML = html;
}

function renderQuizShell() {
  showScreen('screen-quiz');

  screenQuiz.innerHTML = `
    <div class="screen-top">
      <div class="left">
        <h1 id="quiz-title" class="title-left">${escapeHtml(getTestTitle(state.currentTestKey))}</h1>
        <div class="subtitle-left">Пользователь: ${escapeHtml(state.currentUser.username)}</div>
      </div>
      <div class="right">
        <button class="btn-bad" onclick="logout()">🚪 Выйти</button>
      </div>
    </div>
    <div id="counter"></div>
    <div class="progress"><div class="progress-bar" id="progress-bar"></div></div>
    <div id="question"></div>
    <div id="options"></div>
    <button id="next-btn" class="hidden btn-ok" onclick="nextQuestion()">Следующий вопрос</button>
  `;
}

function renderResult() {
  showScreen('screen-result');

  const total = state.questions.length;
  const wrong = total - state.score;
  const percent = total ? Math.round((state.score / total) * 100) : 0;

  let text = state.isRepeatMode ? 'Работа над ошибками (в базу не сохраняется).' : 'Результат сохранён.';
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
      <div class="right">
        <button class="btn-bad" onclick="logout()">🚪 Выйти</button>
      </div>
    </div>
    <div class="result-score">${state.score} / ${total}</div>
    <div class="result-meta">Правильных: ${state.score}, ошибок: ${wrong}, процент: ${percent}%</div>
    <div class="muted">${escapeHtml(text)}</div>
    <div class="toolbar">
      <button class="btn-gray" onclick="backToSelection()">К выбору тестов</button>
      ${state.wrongQuestions.length > 0 && !state.isRepeatMode ? `<button class="btn-ok" onclick="repeatWrong()">Повторить ошибки (${state.wrongQuestions.length})</button>` : ''}
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

function renderAdminPanel(users = [], results = [], accesses = []) {
  showScreen('screen-admin');

  const subjectRows = Object.keys(TEST_TITLES).map(key => `
    <tr><td>${escapeHtml(TEST_TITLES[key])}</td><td><code>${escapeHtml(key)}</code></td></tr>
  `).join('');

  const userRows = users.length
    ? users.map(user => `
        <tr>
          <td>${escapeHtml(user.id)}</td>
          <td>${escapeHtml(user.username)}</td>
          <td>${escapeHtml(user.password)}</td>
          <td>${escapeHtml(user.role)}</td>
          <td>${user.username === state.currentUser.username ? '' : `<button class="btn-bad" style="padding:10px; width:auto;" onclick="deleteUser(${user.id})">❌</button>`}</td>
        </tr>
      `).join('')
    : `<tr><td colspan="5">Пользователей пока нет</td></tr>`;

  const accessRows = accesses.length
    ? accesses.map(row => `
        <tr class="access-row" data-test="${row.test_key}">
          <td>${escapeHtml(row.username)}</td>
          <td>${escapeHtml(getTestTitle(row.test_key))}</td>
          <td>${new Date(row.start_time).toLocaleString()}</td>
          <td>${new Date(row.end_time).toLocaleString()}</td>
          <td><button class="btn-bad" style="padding:10px; width:auto;" onclick="deleteAccess(${row.id})">❌</button></td>
        </tr>
      `).join('')
    : `<tr><td colspan="5">Нет активных доступов</td></tr>`;

  const resultRows = results.length
    ? results.map(row => {
        const testKey = Object.keys(TEST_TITLES).find(k => TEST_TITLES[k] === row.test_name) || 'unknown';
        return `
        <tr class="result-row" data-test="${testKey}">
          <td>${escapeHtml(row.id)}</td>
          <td>${escapeHtml(row.username)}</td>
          <td>${escapeHtml(row.test_name)}</td>
          <td>${escapeHtml(row.score)}/${escapeHtml(row.total)}</td>
          <td>${escapeHtml(row.percentage)}%</td>
          <td><button class="btn-bad" style="padding:10px; width:auto;" onclick="deleteResult(${row.id})">❌</button></td>
        </tr>
      `}).join('')
    : `<tr><td colspan="6">Результатов пока нет</td></tr>`;

  screenAdmin.innerHTML = `
    <div class="screen-top">
      <div class="left">
        <h1 class="title-left">Админ-панель</h1>
        <div class="subtitle-left">Администратор: ${escapeHtml(state.currentUser.username)}</div>
      </div>
      <div class="right">
        <button class="btn-gray" onclick="changeMyPassword()">🔑 Пароль</button>
        <button class="btn-bad" onclick="logout()">🚪 Выйти</button>
      </div>
    </div>

    <div class="admin-tabs">
      <button id="btn-subjects" class="tab-btn" onclick="switchAdminTab('subjects')">Предметы</button>
      <button id="btn-students" class="tab-btn" onclick="switchAdminTab('students')">Студенты</button>
      <button id="btn-exams" class="tab-btn" onclick="switchAdminTab('exams')">Экзамены</button>
      <button id="btn-results" class="tab-btn" onclick="switchAdminTab('results')">Результаты</button>
    </div>

    <div id="tab-subjects" class="tab-content admin-section">
      <h2>Список тестовых предметов</h2>
      <div class="table-wrap"><table><tr><th>Название</th><th>Системный ключ</th></tr>${subjectRows}</table></div>
    </div>

    <div id="tab-students" class="tab-content admin-section">
      <div class="card" style="box-shadow:none; margin-top:0; padding:0; margin-bottom: 20px;">
        <h2>Создать пользователя</h2>
        <input id="new-username" placeholder="Логин" autocomplete="off" />
        <input id="new-password" placeholder="Пароль" autocomplete="off" />
        <select id="new-role">
          <option value="student">student (Студент)</option>
          <option value="admin">admin (Админ)</option>
        </select>
        <button class="btn-ok" onclick="createUser()">Создать</button>
      </div>
      <h2>Список пользователей</h2>
      <div class="table-wrap"><table><tr><th>ID</th><th>Логин</th><th>Пароль</th><th>Роль</th><th>Удалить</th></tr>${userRows}</table></div>
    </div>

    <div id="tab-exams" class="tab-content admin-section">
      <div class="card" style="box-shadow:none; margin-top:0; padding:0; margin-bottom: 20px;">
        <h2>Открыть доступ</h2>
        <select id="access-test">${Object.keys(TEST_TITLES).map(key => `<option value="${key}">${escapeHtml(TEST_TITLES[key])}</option>`).join('')}</select>
        <div id="students-list" class="students-list">Загрузка студентов...</div>
        <label style="display:block;margin-top:15px;">Начало доступа</label><input id="access-start" type="datetime-local">
        <label style="display:block;margin-top:15px;">Конец доступа</label><input id="access-end" type="datetime-local">
        <button class="btn-ok" onclick="grantAccess()">Открыть доступ</button>
        <div class="access-note">Выберите одного или нескольких студентов. Попытки не ограничены.</div>
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
  `;

  loadStudentsList();
  switchAdminTab(currentAdminTab);
}

async function handleLogin() {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value.trim();

  if (!username || !password) { alert('Введите логин и пароль'); return; }

  const { data, error } = await supabaseClient
    .from('users').select('*').eq('username', username).eq('password', password).single();

  if (error || !data) { alert('Неверный логин или пароль'); return; }

  state.currentUser = data;
  setSavedUser(data);

  if (data.role === 'admin') await openAdminPanel();
  else await renderSelection();
}

async function startTest(testKey) {
  document.getElementById('screen-selection').innerHTML = '<h2 style="margin-top:50px; text-align:center;">Загрузка вопросов...</h2>';
  const { data, error } = await supabaseClient.from('questions').select('*').eq('test_key', testKey);

  if (error || !data || data.length === 0) {
    alert('Вопросы для этого предмета еще не добавлены в базу!');
    renderSelection();
    return;
  }

  state.currentTestKey = testKey;
  state.questions = shuffleArray(data.map(cloneQuestion));
  state.currentIndex = 0;
  state.score = 0;
  state.wrongQuestions = [];
  state.isRepeatMode = false;

  renderQuizShell();
  loadQuestion();
}

function loadQuestion() {
  if (!state.questions.length) { finishQuiz(); return; }

  const q = state.questions[state.currentIndex];
  const total = state.questions.length;

  document.getElementById('quiz-title').innerText = getTestTitle(state.currentTestKey);
  document.getElementById('counter').innerText = `Вопрос ${state.currentIndex + 1} из ${total}`;
  document.getElementById('progress-bar').style.width = `${(state.currentIndex / total) * 100}%`;
  document.getElementById('question').innerText = q.q;

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

  document.getElementById('next-btn').classList.remove('hidden');
}

function nextQuestion() {
  state.currentIndex++;
  if (state.currentIndex < state.questions.length) loadQuestion();
  else finishQuiz();
}

async function saveResult() {
  const total = state.questions.length || 1;
  const percentage = Number(((state.score / total) * 100).toFixed(2));

  const { error } = await supabaseClient.from('results').insert([{
    username: state.currentUser.username,
    test_name: getTestTitle(state.currentTestKey),
    score: state.score,
    total: state.questions.length,
    percentage: percentage
  }]);

  if (error) console.error('Ошибка сохранения результата:', error);
}

async function finishQuiz() {
  if (!state.isRepeatMode) await saveResult();
  renderResult();
}

function repeatWrong() {
  state.isRepeatMode = true;
  state.questions = shuffleArray(state.wrongQuestions.map(cloneQuestion));
  state.currentIndex = 0;
  state.score = 0;
  renderQuizShell();
  loadQuestion();
}

function backToSelection() {
  state.currentTestKey = null;
  state.questions = [];
  state.currentIndex = 0;
  state.score = 0;
  renderSelection();
}

function logout() {
  if (!confirm('Вы уверены, что хотите выйти из системы?')) return;
  
  clearSavedUser();
  state.currentUser = null;
  state.currentTestKey = null;
  state.questions = [];
  state.currentIndex = 0;
  state.score = 0;
  state.wrongQuestions = [];
  state.isRepeatMode = false;
  renderLogin();
}

async function loadStudentsList() {
  const container = document.getElementById('students-list');
  if (!container) return;

  const { data, error } = await supabaseClient.from('users').select('*').neq('role', 'admin').order('id', { ascending: true });

  if (error) { container.innerHTML = 'Ошибка загрузки'; return; }
  const students = data || [];
  if (!students.length) { container.innerHTML = '<div class="muted" style="margin:0;">Нет студентов</div>'; return; }

  let html = '';
  students.forEach(user => {
    html += `<label class="student-item"><input type="checkbox" value="${escapeHtml(user.username)}" class="student-checkbox"><span>${escapeHtml(user.username)}</span></label>`;
  });
  container.innerHTML = html;
}

async function grantAccess() {
  const testKey = document.getElementById('access-test').value;
  const usernames = [...document.querySelectorAll('.student-checkbox:checked')].map(cb => cb.value);
  const startRaw = document.getElementById('access-start').value;
  const endRaw = document.getElementById('access-end').value;

  if (!usernames.length || !startRaw || !endRaw) { alert('Заполните поля'); return; }

  const start = new Date(startRaw).toISOString();
  const end = new Date(endRaw).toISOString();

  for (const username of usernames) {
    await supabaseClient.from('test_access').delete().eq('username', username).eq('test_key', testKey);
    const { error } = await supabaseClient.from('test_access').insert([{ username, test_key: testKey, start_time: start, end_time: end, is_active: true }]);
    if (error) { alert('Ошибка выдачи доступа'); return; }
  }
  alert('Доступ успешно открыт');
  await openAdminPanel();
}

async function createUser() {
  const username = document.getElementById('new-username').value.trim();
  const password = document.getElementById('new-password').value.trim();
  const role = document.getElementById('new-role').value;

  if (!username || !password) { alert('Заполните логин и пароль'); return; }

  const { error } = await supabaseClient.from('users').insert([{ username, password, role }]);
  if (error) { alert('Ошибка создания пользователя'); return; }
  
  alert('Пользователь создан');
  await openAdminPanel();
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

  const [usersRes, resultsRes, accessRes] = await Promise.all([
    supabaseClient.from('users').select('*').order('id', { ascending: true }),
    supabaseClient.from('results').select('*').order('id', { ascending: false }),
    supabaseClient.from('test_access').select('*').gte('end_time', now).order('id', { ascending: false })
  ]);

  renderAdminPanel(usersRes.data || [], resultsRes.data || [], accessRes.data || []);
}

function filterTableRows(rowClassName, selectedKey) {
  document.querySelectorAll('.' + rowClassName).forEach(row => {
    row.style.display = (selectedKey === 'all' || row.dataset.test === selectedKey) ? '' : 'none';
  });
}

function init() {
  const savedUser = localStorage.getItem('user');
  if (savedUser) {
    try {
      const parsed = JSON.parse(savedUser);
      state.currentUser = parsed;
      if (parsed.role === 'admin') openAdminPanel();
      else renderSelection();
      return;
    } catch (e) { localStorage.removeItem('user'); }
  }
  renderLogin();
}

init();
</script>
