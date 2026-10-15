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
const screenSorting = document.getElementById('screen-sorting');
const screenKahoot = document.getElementById('screen-kahoot');

let currentAdminTab = 'subjects';
let TEST_TITLES = {};

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
    adminResults: [],
    adminAccesses: [],
    adminHistory: [],
    adminBannedIps: [],
    activeSubjectKey: null,
    editingQuestionId: null,
    activeGroupManager: null,
    adminSortingExercises: [],
    currentSorting: null
};

const SESSION_LIMIT_MS = 5 * 60 * 60 * 1000;
let sessionCheckInterval = null;
let isLoggingIn = false;

// Переменные для Лайв мониторинга
let liveSubscription = null;
let liveStats = {};

// ==========================================
// УТИЛИТЫ И БАЗОВЫЕ ФУНКЦИИ
// ==========================================

async function syncSubjects() {
    const { data } = await supabaseClient.from('subjects').select('*').order('title', { ascending: true });
    TEST_TITLES = {};
    if (data) {
        data.forEach(s => TEST_TITLES[s.test_key] = s.title);
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

// Безопасная подстановка значения внутрь одинарных кавычек в inline
// onclick="...('...')". escapeHtml() одна не спасает: браузер сначала
// декодирует HTML-сущности атрибута, а затем то, что получилось,
// выполняется как JS. Поэтому сперва экранируем спецсимволы JS-строки,
// и только потом — HTML-сущности самого атрибута.
function jsAttr(value) {
    const escapedForJs = String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return escapeHtml(escapedForJs);
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
    const screens = [screenLogin, screenSelection, screenQuiz, screenResult, screenAdmin, screenSorting, screenKahoot];
    screens.forEach(s => { if(s) s.classList.add('hidden'); });
    
    const target = document.getElementById(activeId);
    if(target) {
        target.classList.remove('hidden');
        if (activeId === 'screen-selection' || activeId === 'screen-admin') {
            target.innerHTML = '<h2 style="text-align:center; padding: 50px; color:#6b7280;">⏳ Загрузка данных...</h2>';
        }
    }
}

function setSavedUser(user) { localStorage.setItem('user', JSON.stringify(user)); }
function clearSavedUser() { localStorage.removeItem('user'); }

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

function clearTestProgress() { localStorage.removeItem('test_progress'); }
function getTestTitle(key) { return TEST_TITLES[key] || key; }

async function getIPAddress() {
    try {
        const response = await fetch('https://api.ipify.org?format=json');
        const data = await response.json();
        return data.ip;
    } catch (e) {
        return 'Скрыт/VPN';
    }
}

// ==========================================
// БЕЗОПАСНОСТЬ И АВТОРИЗАЦИЯ
// ==========================================

async function securityCheck() {
    if (!state.currentUser || state.currentUser.role === 'admin' || state.currentUser.role === 'superadmin') return;

    const { data: userData, error: userError } = await supabaseClient
        .from('users')
        .select('session_token')
        .eq('id', state.currentUser.id)
        .single();

    // Реагируем только на явное расхождение токенов. Сетевая ошибка/таймаут
    // (например, сразу после обновления страницы) не должны разлогинивать.
    if (!userError && userData && userData.session_token !== state.currentUser.session_token) {
        alert('⚠️ Ваш аккаунт был использован на другом устройстве. Выполнен автоматический выход.');
        window.logout(true);
        return;
    }

    if (state.currentTestKey && !state.isRepeatMode) {
        const now = new Date().toISOString();
        const { data: accessData, error: accessError } = await supabaseClient
            .from('test_access')
            .select('id')
            .eq('username', state.currentUser.username)
            .eq('test_key', state.currentTestKey)
            .eq('is_active', true)
            .lte('start_time', now)
            .gte('end_time', now);

        // Прерываем тест только если запрос точно выполнился и доступа
        // действительно нет. При ошибке — просто повторим через 15 секунд.
        if (!accessError && (!accessData || accessData.length === 0)) {
            alert('⛔ Администратор закрыл вам доступ к этому тесту (или вышло время). Тест прерван.');
            clearTestProgress();
            window.backToSelection();
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
        <button id="login-kahoot-btn" class="ql-login-button" type="button">🎮 Войти в игру по PIN-коду</button>
    `;
    document.getElementById('login-btn').addEventListener('click', handleLogin);
    document.getElementById('login-kahoot-btn').addEventListener('click', window.openKahootMenu);
    document.getElementById('password').addEventListener('keydown', (e) => { 
        if (e.key === 'Enter' && !isLoggingIn) handleLogin(); 
    });
}

async function handleLogin() {
    if (isLoggingIn) return;

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value.trim();
    if (!username || !password) { 
        alert('Введите логин и пароль'); 
        return; 
    }

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

    const sessionToken = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).substring(2, 15));
    await supabaseClient.from('users').update({ session_token: sessionToken }).eq('id', data.id);
    await supabaseClient.from('login_history').insert([{ username: data.username, ip_address: userIP }]);

    const sessionData = { ...data, session_token: sessionToken, loginTimestamp: Date.now() };
    state.currentUser = sessionData;
    setSavedUser(sessionData);

    if (sessionCheckInterval) clearInterval(sessionCheckInterval);
    sessionCheckInterval = setInterval(securityCheck, 15000);

    isLoggingIn = false;
    await syncSubjects();

    if (/kahoot=\d{6}/i.test(window.location.hash)) {
        await window.openKahootMenu();
        return;
    }

    if (data.role === 'admin' || data.role === 'superadmin') {
        await openAdminPanel();
    } else {
        await window.renderSelection();
    }
}

window.changeMyPassword = async function() {
    const newPassword = prompt('Введите новый пароль (оставьте пустым для отмены):');
    if (!newPassword || newPassword.trim() === '') return;

    const { error } = await supabaseClient.from('users').update({ password: newPassword.trim() }).eq('id', state.currentUser.id);

    if (error) {
        alert('Ошибка при смене пароля.');
    } else {
        alert('Пароль успешно изменен!');
        state.currentUser.password = newPassword.trim();
        setSavedUser(state.currentUser);
        if (state.currentUser.role === 'admin' || state.currentUser.role === 'superadmin') openAdminPanel();
    }
};

window.logout = function(force = false) {
    if (!force && !confirm('Вы уверены, что хотите выйти из системы?')) return;
    if (sessionCheckInterval) clearInterval(sessionCheckInterval);
    clearSavedUser();
    clearTestProgress();
    location.reload(); 
};

// ==========================================
// ИНТЕРФЕЙС СТУДЕНТА (ВЫБОР ТЕСТА)
// ==========================================

window.renderSelection = async function() {
    showScreen('screen-selection');
    await syncSubjects();
    
    const now = new Date().toISOString();
    const { data, error } = await supabaseClient
        .from('test_access')
        .select('*')
        .eq('username', state.currentUser.username)
        .eq('is_active', true)
        .lte('start_time', now)
        .gte('end_time', now);

    if (error) { 
        screenSelection.innerHTML = `<h1 style="color:red; text-align:center; margin-top:20px;">Ошибка доступа к базе</h1>`; 
        return; 
    }

    let html = `
        <div class="screen-top">
            <div class="left">
                <h1 class="title-left">Доступные тесты</h1>
                <div class="subtitle-left">Пользователь: ${escapeHtml(state.currentUser.username)}</div>
            </div>
            <div class="right">
                <button class="ql-mini-button" onclick="window.openKahootMenu()">🎮 Kahoot-режим</button>
                <button class="btn-gray" onclick="window.renderSelection()">🔄 Обновить</button>
                <button class="btn-gray" onclick="window.changeMyPassword()">🔑 Пароль</button>
                <button class="btn-bad" onclick="window.logout()">🚪 Выйти</button>
            </div>
        </div>
    `;

    if (!data.length) {
        html += `<div class="muted">Сейчас вам недоступны тесты</div>`;
        screenSelection.innerHTML = html;
        return;
    }
    
    const testKeys = data.map(d => d.test_key);
    const { data: qData } = await supabaseClient.from('test_parts_summary').select('test_key, part_name').in('test_key', testKeys);
    const { data: sortData } = await supabaseClient.from('sorting_exercises').select('test_key').in('test_key', testKeys);
    
    const partsMap = {};
    testKeys.forEach(k => partsMap[k] = new Set());
    
    if (qData) {
        qData.forEach(q => { partsMap[q.test_key].add(q.part_name || 'Основная часть'); });
    }

    const sortingCountMap = {};
    testKeys.forEach(k => sortingCountMap[k] = 0);
    (sortData || []).forEach(s => { sortingCountMap[s.test_key] = (sortingCountMap[s.test_key] || 0) + 1; });

    html += `<div style="max-width:600px; margin:0 auto;">`;
    data.forEach(test => { 
        const parts = Array.from(partsMap[test.test_key] || ['Основная часть']);
        
        const used = test.used_attempts || 0;
        const max = test.max_attempts || 1;
        const isExhausted = (test.max_attempts !== undefined) && (used >= max);
        
        let attemptsBadge = '';
        if (test.max_attempts !== undefined) {
            attemptsBadge = `<div style="font-size:13px; margin-bottom:10px; color:${isExhausted ? 'var(--bad)' : 'var(--ok)'};"><b>Попыток: ${used} из ${max}</b></div>`;
        }

        let partsButtons = `<button class="btn-ok" style="margin:0; margin-bottom:5px; width:auto; padding:8px 15px; font-size:13px;" onclick="window.startTest('${jsAttr(test.test_key)}', 'all')">▶️ Полный тест</button>`;
        
        if (parts.length > 1 || (parts.length === 1 && parts[0] !== 'Основная часть')) {
            partsButtons += ' ' + parts.map(p => 
                `<button class="btn-primary" style="margin:0; margin-bottom:5px; width:auto; padding:8px 15px; font-size:13px; background:#3b82f6;" onclick="window.startTest('${jsAttr(test.test_key)}', 'part', '${jsAttr(p)}')">▶️ ${escapeHtml(p)}</button>`
            ).join(' ');
        }

        if (isExhausted) {
            partsButtons = `<div class="muted" style="margin-bottom:10px; text-align:left;">❌ Вы исчерпали доступные попытки для этого теста.</div>`;
        }

        if (sortingCountMap[test.test_key] > 0) {
            partsButtons += ` <button class="btn-primary" style="margin:0; margin-bottom:5px; width:auto; padding:8px 15px; font-size:13px; background:#8b5cf6;" onclick="window.openSortingList('${jsAttr(test.test_key)}')">🗂️ Сортировка</button>`;
        }

        html += `
        <div class="card" style="box-shadow:none; border:1px solid #d7dce3; margin-bottom:15px; text-align:left;">
            <h3 style="margin-top:0; margin-bottom:6px;">${escapeHtml(getTestTitle(test.test_key))}</h3>
            ${attemptsBadge}
            <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom: 10px;">
                ${partsButtons}
            </div>
            <div style="display:flex; gap:10px; flex-wrap:wrap; border-top: 1px solid #eee; padding-top: 10px;">
                <button class="btn-bad" style="margin:0; width:auto; padding:8px 15px; font-size:13px;" onclick="window.startTest('${jsAttr(test.test_key)}', 'wrong')">❌ Ошибки</button>
                <button class="btn-gray" style="margin:0; width:auto; padding:8px 15px; font-size:13px;" onclick="window.startTest('${jsAttr(test.test_key)}', 'favorite')">⭐ Избранные</button>
            </div>
        </div>
        `; 
    });
    html += `</div>`;
    
    screenSelection.innerHTML = html;
};

// ==========================================
// ЛОГИКА ПРОХОЖДЕНИЯ ТЕСТА
// ==========================================

window.startTest = async function(testKey, mode, partName = null) {
    const now = new Date().toISOString();
    
    // Проверяем доступ и количество попыток
    const { data: accessData } = await supabaseClient.from('test_access')
        .select('*')
        .eq('username', state.currentUser.username)
        .eq('test_key', testKey)
        .eq('is_active', true)
        .lte('start_time', now)
        .gte('end_time', now)
        .single();
    
    if (!accessData) { 
        alert('У вас нет активного доступа к этому тесту (возможно вышло время).'); 
        return window.renderSelection(); 
    }
    
    const usedAttempts = accessData.used_attempts || 0;
    const maxAttempts = accessData.max_attempts || 1;

    // Режим ошибок и избранного не тратит попытки
    if (mode !== 'wrong' && mode !== 'favorite') {
        if (accessData.max_attempts !== undefined && usedAttempts >= maxAttempts) {
            alert('Вы исчерпали количество доступных попыток для этого теста!');
            return window.renderSelection();
        }

        if (accessData.max_attempts !== undefined) {
            // Списываем попытку атомарно: условие .eq('used_attempts', usedAttempts)
            // гарантирует, что запись пройдёт, только если число попыток с момента
            // чтения не изменилось. Если кто-то (двойной клик, вторая вкладка,
            // повторная отправка запроса) уже успел списать попытку в этот же
            // момент — эта запись не выполнится, вместо того чтобы тихо потеряться.
            const { data: updated, error: updateError } = await supabaseClient.from('test_access')
                .update({ used_attempts: usedAttempts + 1 })
                .eq('id', accessData.id)
                .eq('used_attempts', usedAttempts)
                .select();

            if (updateError) {
                console.warn("Ошибка списания попытки, продолжаем без списания:", updateError);
            } else if (!updated || updated.length === 0) {
                alert('Не удалось начать тест: похоже, попытка уже была списана только что (например, в другой вкладке). Обновите страницу и попробуйте снова.');
                return window.renderSelection();
            }
        }
    }

    document.getElementById('screen-selection').innerHTML = '<h2 style="margin-top:50px; text-align:center;">⏳ Загрузка вопросов...</h2>';

    const { data: sData } = await supabaseClient.from('student_q_state')
        .select('*')
        .eq('username', state.currentUser.username)
        .eq('test_key', testKey);
       
    state.qStates = {};
    (sData || []).forEach(row => { 
        state.qStates[row.question_id] = { id: row.id, is_correct: row.is_correct, is_favorite: row.is_favorite }; 
    });

    let filteredQs;
    if (mode === 'wrong' || mode === 'favorite') {
        // Знаем конкретные question_id заранее — тянем только их,
        // а не весь банк вопросов теста (может быть сотни строк).
        const wantedIds = Object.keys(state.qStates)
            .filter(qid => mode === 'wrong' ? state.qStates[qid].is_correct === false : state.qStates[qid].is_favorite === true)
            .map(Number);

        if (!wantedIds.length) {
            alert(mode === 'wrong' ? 'Отличная работа! У вас нет ошибок.' : 'Избранных вопросов нет.');
            window.renderSelection();
            return;
        }

        const { data, error } = await supabaseClient.from('questions').select('*').in('id', wantedIds);
        if (error || !data || !data.length) { alert('Вопросы не найдены!'); window.renderSelection(); return; }
        filteredQs = data;
    } else {
        const { data: qData, error: qError } = await supabaseClient.from('questions').select('*').eq('test_key', testKey);
        if (qError || !qData || qData.length === 0) { 
            alert('Вопросы не найдены!'); 
            window.renderSelection(); 
            return; 
        }

        if (mode === 'part' && partName) {
            filteredQs = qData.filter(q => (q.part_name || 'Основная часть') === partName);
            if (!filteredQs.length) { alert('В этой части нет вопросов!'); window.renderSelection(); return; }
        } else {
            filteredQs = qData;
        }
    }

    state.currentTestKey = testKey;
    state.currentPartName = partName; 
    state.questions = shuffleArray(filteredQs.map(cloneQuestion));
    state.currentIndex = 0;
    state.score = 0;
    state.wrongQuestions = [];
    state.isRepeatMode = (mode !== 'part' && mode !== 'all'); 
    
    saveTestProgress(false); 
    renderQuizShell();
    window.loadQuestion();
};

window.pauseTest = async function() {
    if (!confirm('Приостановить тест и вернуться в меню? Ваш прогресс будет сохранен (попытка считается начатой).')) return;
    
    if (!state.isRepeatMode) {
        document.getElementById('screen-quiz').innerHTML = '<h2 style="text-align:center; padding: 50px;">Сохранение...</h2>';
        await saveResult('incomplete');
    }
    
    window.backToSelection();
};

function renderQuizShell() {
    showScreen('screen-quiz');
    screenQuiz.innerHTML = `
        <div class="screen-top">
            <div class="left" style="display:flex; align-items:center;">
                <button class="btn-gray" style="padding:6px 12px; margin-right:15px; font-size:14px; width:auto;" onclick="window.pauseTest()">🔙 Назад (Пауза)</button>
                <div>
                    <h1 id="quiz-title" class="title-left" style="margin:0;">
                        ${escapeHtml(getTestTitle(state.currentTestKey))}
                        ${state.currentPartName ? `<span style="font-size:16px; color:#888;">(${escapeHtml(state.currentPartName)})</span>` : ''}
                    </h1>
                    <div class="subtitle-left">Пользователь: ${escapeHtml(state.currentUser.username)}</div>
                </div>
            </div>
            <div class="right"><button class="btn-bad" onclick="window.logout()">🚪 Выйти</button></div>
        </div>
        <div id="counter"></div>
        <div class="progress"><div class="progress-bar" id="progress-bar"></div></div>
        <div id="question" style="font-size:18px;"></div>
        <div id="options"></div>
        <button id="next-btn" class="hidden btn-ok" onclick="window.nextQuestion()">Следующий вопрос</button>
    `;
}

window.loadQuestion = function() {
    if (!state.questions.length) { window.finishQuiz(); return; }
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
    
    document.getElementById('question').innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
            <div>${escapeHtml(q.q)}</div>
            <button id="btn-favorite" onclick="window.toggleFavorite()" style="background:none; border:none; font-size:28px; cursor:pointer; padding:0; margin-left:15px; outline:none; color:${st.is_favorite ? '#f59e0b' : '#cbd5e1'};">★</button>
        </div>`;

    const options = document.getElementById('options');
    options.innerHTML = '';
    
    shuffleArray(q.a.map((text, idx) => ({ text, correct: idx === q.c }))).forEach(item => {
        const btn = document.createElement('button');
        btn.className = 'option'; 
        btn.textContent = item.text; 
        btn.dataset.correct = item.correct ? '1' : '0';
        btn.addEventListener('click', () => window.selectAnswer(btn, item.correct));
        options.appendChild(btn);
    });
    
    document.getElementById('next-btn').classList.add('hidden');
};

window.toggleFavorite = function() {
    const q = state.questions[state.currentIndex];
    let st = state.qStates[q.id] || { is_correct: null, is_favorite: false };
    st.is_favorite = !st.is_favorite; 
    state.qStates[q.id] = st;
    
    document.getElementById('btn-favorite').style.color = st.is_favorite ? '#f59e0b' : '#cbd5e1';
    
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

window.selectAnswer = function(selectedBtn, isCorrect) {
    const buttons = document.querySelectorAll('#options .option');
    buttons.forEach(btn => btn.disabled = true);
    buttons.forEach(btn => { if (btn.dataset.correct === '1') btn.classList.add('correct'); });

    if (!isCorrect) { 
        selectedBtn.classList.add('wrong'); 
        if (!state.isRepeatMode) state.wrongQuestions.push(cloneQuestion(state.questions[state.currentIndex])); 
    } else {
        state.score++;
    }

    const qId = state.questions[state.currentIndex].id;
    let st = state.qStates[qId] || { is_correct: null, is_favorite: false };
    st.is_correct = isCorrect; 
    state.qStates[qId] = st;
    saveQState(qId, isCorrect, st.is_favorite);

    saveTestProgress(true); 
    document.getElementById('next-btn').classList.remove('hidden');
};

window.nextQuestion = function() { 
    state.currentIndex++; 
    if (state.currentIndex < state.questions.length) {
        window.loadQuestion(); 
    } else {
        window.finishQuiz(); 
    }
};

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
        test_key: state.currentTestKey,
        score: state.score, 
        total: state.questions.length, 
        percentage: percentage, 
        status: status 
    }]);
}

window.finishQuiz = async function() { 
    clearTestProgress(); 
    if (!state.isRepeatMode) await saveResult('completed'); 
    renderResult(); 
};

window.backToSelection = function() { 
    state.currentTestKey = null; 
    state.currentPartName = null; 
    state.questions = []; 
    state.currentIndex = 0; 
    state.score = 0; 
    clearTestProgress(); 
    window.renderSelection(); 
};

function renderResult() {
    showScreen('screen-result');
    const total = state.questions.length;
    const wrong = total - state.score;
    const percent = total ? Math.round((state.score / total) * 100) : 0;

    let text = state.isRepeatMode ? 'Тренировка завершена (в базу не сохраняется).' : 'Результат сохранён. Вы использовали 1 попытку.';
    if (!state.isRepeatMode) {
        if (percent >= 90) text += ' Отличный результат.';
        else if (percent >= 60) text += ' Проходной балл.';
        else if (percent >= 0) text += ' Нужно повторить материал.';
    }

    screenResult.innerHTML = `
        <div class="screen-top">
            <div class="left">
                <h1 class="title-left">Тест завершён</h1>
                <div class="subtitle-left">Пользователь: ${escapeHtml(state.currentUser.username)}</div>
            </div>
            <div class="right"><button class="btn-bad" onclick="window.logout()">🚪 Выйти</button></div>
        </div>
        <div class="result-score">${state.score} / ${total}</div>
        <div class="result-meta">Правильных: ${state.score}, ошибок: ${wrong}, процент: ${percent}%</div>
        <div class="muted">${escapeHtml(text)}</div>
        <div class="toolbar">
            <button class="btn-gray" onclick="window.backToSelection()">К выбору тестов</button>
        </div>
    `;
}

// ==========================================
// ЛОГИКА СОРТИРОВКИ ПО КОРЗИНАМ
// ==========================================

window.openSortingList = async function(testKey) {
    document.getElementById('screen-selection').innerHTML = '<h2 style="margin-top:50px; text-align:center;">⏳ Загрузка...</h2>';
    const { data, error } = await supabaseClient.from('sorting_exercises').select('id, title').eq('test_key', testKey);
    if (error || !data || !data.length) { alert('Заданий на сортировку пока нет.'); window.renderSelection(); return; }

    // Если задание одно — сразу открываем его, без лишнего экрана выбора
    if (data.length === 1) {
        window.startSorting(data[0].id);
        return;
    }

    document.getElementById('screen-selection').innerHTML = `
        <div class="screen-top">
            <div class="left"><h1 class="title-left">Выберите задание</h1></div>
            <div class="right"><button class="btn-gray" onclick="window.renderSelection()">🔙 Назад</button></div>
        </div>
        <div style="max-width:600px; margin:0 auto;">
            ${data.map(ex => `
                <div class="card" style="box-shadow:none; border:1px solid #d7dce3; margin-bottom:12px; text-align:left; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
                    <div style="font-weight:bold;">${escapeHtml(ex.title)}</div>
                    <button class="btn-ok" style="margin:0; width:auto; padding:8px 15px;" onclick="window.startSorting(${ex.id})">▶️ Начать</button>
                </div>
            `).join('')}
        </div>
    `;
};

window.startSorting = async function(exerciseId) {
    document.getElementById('screen-selection').innerHTML = '<h2 style="margin-top:50px; text-align:center;">⏳ Загрузка задания...</h2>';

    const { data, error } = await supabaseClient.from('sorting_exercises').select('*').eq('id', exerciseId).single();
    if (error || !data) { alert('Задание не найдено!'); window.renderSelection(); return; }

    const items = shuffleArray((data.items || []).map(it => ({ word: it.word, basket: it.basket, placedIn: null })));

    state.currentSorting = {
        id: data.id,
        testKey: data.test_key,
        title: data.title,
        baskets: data.baskets || [],
        items: items,
        selectedItemIndex: null,
        checked: false
    };

    renderSortingScreen();
};

function renderSortingScreen() {
    showScreen('screen-sorting');
    const s = state.currentSorting;

    const basketsHtml = s.baskets.map((label, bIdx) => {
        const chips = s.items.map((it, idx) => ({ it, idx }))
            .filter(({ it }) => it.placedIn === bIdx)
            .map(({ it, idx }) => {
                let cls = 'word-chip';
                if (s.checked) cls += (it.placedIn === it.basket) ? ' correct' : ' wrong';
                return `<span class="${cls}" onclick="window.sortWordClick(${idx}, event)">${escapeHtml(it.word)}</span>`;
            }).join('');
        return `
            <div class="sorting-basket" onclick="window.sortBasketClick(${bIdx})">
                <div class="sorting-basket-title">${escapeHtml(label)}</div>
                <div class="sorting-basket-body">${chips || '<span class="muted" style="font-size:13px; margin:0;">—</span>'}</div>
            </div>
        `;
    }).join('');

    const poolHtml = s.items.map((it, idx) => ({ it, idx }))
        .filter(({ it }) => it.placedIn === null)
        .map(({ it, idx }) => {
            const selected = (s.selectedItemIndex === idx) ? ' selected' : '';
            return `<span class="word-chip${selected}" onclick="window.sortWordClick(${idx}, event)">${escapeHtml(it.word)}</span>`;
        }).join('');

    const allPlaced = s.items.every(it => it.placedIn !== null);
    const correctCount = s.items.filter(it => it.placedIn === it.basket).length;

    screenSorting.innerHTML = `
        <div class="screen-top">
            <div class="left" style="display:flex; align-items:center;">
                <button class="btn-gray" style="padding:6px 12px; margin-right:15px; font-size:14px; width:auto;" onclick="window.exitSorting()">🔙 Назад</button>
                <div>
                    <h1 class="title-left" style="margin:0;">${escapeHtml(s.title)}</h1>
                    <div class="subtitle-left">Пользователь: ${escapeHtml(state.currentUser.username)}</div>
                </div>
            </div>
            <div class="right"><button class="btn-bad" onclick="window.logout()">🚪 Выйти</button></div>
        </div>

        <div class="muted" style="margin-bottom:10px;">Нажмите на слово, затем нажмите на нужную корзину. Чтобы вернуть слово обратно — нажмите на него ещё раз.</div>

        <div class="sorting-baskets">${basketsHtml}</div>

        <div class="sorting-pool">${poolHtml || '<span class="muted" style="font-size:14px; margin:0;">Все слова разложены</span>'}</div>

        ${s.checked ? `
            <div class="result-meta" style="margin-top:15px;">Правильно: ${correctCount} из ${s.items.length}</div>
            <div class="toolbar"><button class="btn-gray" onclick="window.backToSelection()">К выбору тестов</button></div>
        ` : `
            <button class="btn-ok" style="margin-top:15px; ${allPlaced ? '' : 'opacity:.5;'}" ${allPlaced ? '' : 'disabled'} onclick="window.checkSorting()">✅ Проверить</button>
            <div class="sorting-progress-note">${allPlaced ? 'Можно проверять!' : 'Разложите все слова по корзинам'}</div>
        `}
    `;
}

window.sortWordClick = function(idx, event) {
    if (event) event.stopPropagation();
    const s = state.currentSorting;
    if (!s || s.checked) return;
    const item = s.items[idx];

    if (item.placedIn !== null) {
        item.placedIn = null;
        s.selectedItemIndex = null;
    } else if (s.selectedItemIndex === idx) {
        s.selectedItemIndex = null;
    } else {
        s.selectedItemIndex = idx;
    }
    renderSortingScreen();
};

window.sortBasketClick = function(basketIdx) {
    const s = state.currentSorting;
    if (!s || s.checked || s.selectedItemIndex === null) return;
    s.items[s.selectedItemIndex].placedIn = basketIdx;
    s.selectedItemIndex = null;
    renderSortingScreen();
};

window.checkSorting = async function() {
    const s = state.currentSorting;
    if (!s || s.items.some(it => it.placedIn === null)) return;

    s.checked = true;
    renderSortingScreen();

    const correctCount = s.items.filter(it => it.placedIn === it.basket).length;
    const total = s.items.length;
    const percentage = Number(((correctCount / total) * 100).toFixed(2));

    await supabaseClient.from('results').insert([{
        username: state.currentUser.username,
        test_name: `${getTestTitle(s.testKey)} — Сортировка: ${s.title}`,
        test_key: s.testKey,
        score: correctCount,
        total: total,
        percentage: percentage,
        status: 'completed',
        activity_type: 'sorting'
    }]);
};

window.exitSorting = function() {
    state.currentSorting = null;
    window.renderSelection();
};

// ==========================================
// АДМИН ПАНЕЛЬ И УПРАВЛЕНИЕ
// ==========================================

window.switchAdminTab = function(tabId) {
    currentAdminTab = tabId;
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    
    const btn = document.getElementById('btn-' + tabId);
    const content = document.getElementById('tab-' + tabId);
    if(btn && content) {
        btn.classList.add('active');
        content.classList.add('active');
    }
};

window.createSubject = async function() {
    const title = document.getElementById('new-subj-title').value.trim();
    let key = document.getElementById('new-subj-key').value.trim().toLowerCase();
    
    if(!title || !key) return alert('Заполните оба поля: название и системный ключ!');
    if(!/^[a-z0-9_]+$/.test(key)) return alert('Ключ должен содержать только английские буквы, цифры и знак подчеркивания _ (без пробелов)!');
    
    const {error} = await supabaseClient.from('subjects').insert([{test_key: key, title: title}]);
    if(error) return alert('Ошибка создания. Возможно предмет с таким ключом уже существует.');
    
    document.getElementById('new-subj-title').value = '';
    document.getElementById('new-subj-key').value = '';
    openAdminPanel();
};

window.renameSubject = async function(key) {
    const currentTitle = TEST_TITLES[key];
    const newTitle = prompt(`Введите новое название для предмета:`, currentTitle);
    if(!newTitle || newTitle.trim() === currentTitle) return;
    
    const {error} = await supabaseClient.from('subjects').update({title: newTitle.trim()}).eq('test_key', key);
    if(error) return alert('Ошибка при переименовании');
    openAdminPanel();
};

window.deleteSubject = async function(key) {
    const title = TEST_TITLES[key];
    if(!confirm(`Удалить предмет "${title}" со всеми вопросами и доступами?`)) return;
    
    document.getElementById('subjects-list-container').innerHTML = '<h2 style="text-align:center; padding: 50px;">⏳ Удаление...</h2>';
    await supabaseClient.from('questions').delete().eq('test_key', key);
    await supabaseClient.from('test_access').delete().eq('test_key', key);
    await supabaseClient.from('subjects').delete().eq('test_key', key);
    openAdminPanel();
};

// --- Управление группами ---
window.createGroup = async function() {
    const groupName = document.getElementById('new-group-input').value.trim();
    if (!groupName) return alert('Введите название группы');
    const { error } = await supabaseClient.from('groups').insert([{ name: groupName }]);
    if (error) alert('Ошибка создания (группа уже существует)');
    else await refreshAdminSlice(['groups']);
};

window.deleteGroup = async function(id, name) {
    if (!confirm(`Удалить группу "${name}"? Студенты будут переведены в "Без группы".`)) return;
    await supabaseClient.from('users').update({ group_name: 'Без группы' }).eq('group_name', name);
    await supabaseClient.from('groups').delete().eq('id', id);
    await refreshAdminSlice(['users', 'groups']);
};

window.openGroupManager = function(groupName) {
    state.activeGroupManager = groupName;
    document.getElementById('students-main-view').classList.add('hidden');
    document.getElementById('group-editor-view').classList.remove('hidden');
    document.getElementById('group-editor-title').innerText = `Состав группы: ${escapeHtml(groupName)}`;
    
    const groupUsers = state.adminUsers.filter(u => u.group_name === groupName && u.role === 'student');
    const groupUsersHtml = groupUsers.length ? groupUsers.map(u => `
        <tr><td>${escapeHtml(u.username)}</td><td><button class="btn-bad" style="padding:6px 12px; width:auto; font-size:12px;" onclick="window.removeUserFromGroup(${u.id})">Исключить</button></td></tr>
    `).join('') : `<tr><td colspan="2" class="muted">В группе пока нет студентов</td></tr>`;
    document.getElementById('group-members-list').innerHTML = `<table><tr><th>Студент</th><th>Действие</th></tr>${groupUsersHtml}</table>`;

    const availableUsers = state.adminUsers.filter(u => u.group_name !== groupName && u.role === 'student');
    const optionsHtml = availableUsers.length ? availableUsers.map(u => `<option value="${u.id}">${escapeHtml(u.username)} (сейчас: ${escapeHtml(u.group_name || 'Без группы')})</option>`).join('') : `<option value="">Нет доступных студентов</option>`;
    document.getElementById('add-to-group-select').innerHTML = optionsHtml;
};

window.closeGroupManager = function() {
    state.activeGroupManager = null;
    document.getElementById('group-editor-view').classList.add('hidden');
    document.getElementById('students-main-view').classList.remove('hidden');
};

window.addUserToGroup = async function() {
    const userId = document.getElementById('add-to-group-select').value;
    if (!userId) return alert('Выберите студента');
    await supabaseClient.from('users').update({ group_name: state.activeGroupManager }).eq('id', userId);
    await refreshAdminSlice(['users']);
};

window.removeUserFromGroup = async function(userId) {
    if (!confirm('Исключить студента из группы?')) return;
    await supabaseClient.from('users').update({ group_name: 'Без группы' }).eq('id', userId);
    await refreshAdminSlice(['users']);
};


// --- Управление вопросами ---
window.openSubjectManager = async function(testKey) {
    state.activeSubjectKey = testKey;
    document.getElementById('subjects-list-container').classList.add('hidden');
    document.getElementById('subject-editor-container').classList.remove('hidden');
    document.getElementById('subject-editor-title').innerText = 'Загрузка вопросов...';
    
    const { data, error } = await supabaseClient.from('questions').select('*').eq('test_key', testKey).order('id', { ascending: true });
    if (error) { alert('Ошибка загрузки вопросов'); return; }
    
    state.adminQuestions = data || [];

    const { data: sortData } = await supabaseClient.from('sorting_exercises').select('*').eq('test_key', testKey).order('id', { ascending: true });
    state.adminSortingExercises = sortData || [];

    renderSubjectQuestionsList();
};

window.closeSubjectManager = function() {
    state.activeSubjectKey = null;
    state.editingQuestionId = null;
    document.getElementById('subject-editor-container').classList.add('hidden');
    document.getElementById('subjects-list-container').classList.remove('hidden');
};

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
            if (part.startsWith('#')) { correctIdx = i; options.push(part.substring(1).trim()); } 
            else { options.push(part); }
        }
        if (options.length > 0) { 
            questionsToInsert.push({ test_key: state.activeSubjectKey, part_name: partName, q: qText, a: options, c: correctIdx }); 
        }
    }
    
    if (!questionsToInsert.length) {
        alert('Вопросы не распознаны.');
        document.getElementById('import-btn').innerText = 'Импортировать вопросы';
        document.getElementById('import-btn').disabled = false;
        return;
    }

    const { error } = await supabaseClient.from('questions').insert(questionsToInsert);
    if (error) {
        alert('Ошибка при импорте');
    } else {
        alert(`Успешно импортировано ${questionsToInsert.length} вопросов в раздел "${partName}"!`);
        document.getElementById('import-text').value = '';
        window.openSubjectManager(state.activeSubjectKey);
    }
};

window.toggleAllCheckboxes = function(checkbox, className) {
    document.querySelectorAll('.' + className).forEach(cb => cb.checked = checkbox.checked);
};

window.deleteSelectedQuestions = async function() {
    const checkboxes = document.querySelectorAll('.question-checkbox:checked');
    const selectedIds = Array.from(checkboxes).map(cb => parseInt(cb.value));
    
    if (selectedIds.length === 0) return alert('Выберите галочкой хотя бы один вопрос!');
    if (!confirm(`Удалить выбранные вопросы (${selectedIds.length} шт.)?`)) return;

    document.getElementById('questions-list-render').innerHTML = '<h2 style="text-align:center; padding: 50px;">Удаление...</h2>';
    await supabaseClient.from('questions').delete().in('id', selectedIds);
    window.openSubjectManager(state.activeSubjectKey);
};

// Функция массового удаления РЕЗУЛЬТАТОВ
window.deleteSelectedResults = async function(tableNameType) {
    const className = tableNameType === 'completed' ? 'result-checkbox' : 'incomplete-checkbox';
    const checkboxes = document.querySelectorAll('.' + className + ':checked');
    const selectedIds = Array.from(checkboxes).map(cb => parseInt(cb.value));
    
    if (selectedIds.length === 0) {
        return alert('Выберите галочкой хотя бы один результат!');
    }
    if (!confirm(`Удалить выбранные результаты (${selectedIds.length} шт.)?`)) {
        return;
    }

    const targetTab = tableNameType === 'completed' ? 'tab-results' : 'tab-incomplete';
    document.getElementById(targetTab).style.opacity = '0.5';
    
    const { error } = await supabaseClient.from('results').delete().in('id', selectedIds);
    if (error) { 
        alert('Ошибка при удалении'); 
        console.error(error);
        document.getElementById(targetTab).style.opacity = '1'; 
    } else {
        await refreshAdminSlice(['results']);
    }
};

window.splitQuestionsIntoParts = async function() {
    if (state.adminQuestions.length === 0) return alert("Нет вопросов для разделения.");
    
    const numPartsStr = prompt(`На сколько равных частей разделить ${state.adminQuestions.length} вопросов?`);
    if (!numPartsStr) return;
    
    const numParts = parseInt(numPartsStr, 10);
    if (isNaN(numParts) || numParts < 2 || numParts > state.adminQuestions.length) return alert("Некорректное число.");

    document.getElementById('questions-list-render').innerHTML = '<h2 style="text-align:center; padding: 50px;">⏳ Разделение...</h2>';
    
    const chunkSize = Math.ceil(state.adminQuestions.length / numParts);
    const promises = state.adminQuestions.map((q, index) => {
        const partNum = Math.floor(index / chunkSize) + 1;
        const newPartName = `Часть ${partNum}`;
        if (q.part_name !== newPartName) {
            return supabaseClient.from('questions').update({ part_name: newPartName }).eq('id', q.id);
        }
        return Promise.resolve();
    });

    try {
        await Promise.all(promises);
        alert(`Вопросы разделены на ${numParts} частей!`);
    } catch (e) { 
        alert('Ошибка при разделении.'); 
    }
    window.openSubjectManager(state.activeSubjectKey);
};

window.importSortingExercise = async function() {
    const title = document.getElementById('sorting-title').value.trim();
    const text = document.getElementById('sorting-import-text').value;

    if (!title) return alert('Введите название задания!');
    if (!text.trim()) return alert('Вставьте корзины и слова!');

    const blocks = text.split('+++++').map(b => b.trim()).filter(b => b);
    if (blocks.length < 2) return alert('Нужно минимум 2 корзины (разделите их строкой +++++)!');

    const baskets = [];
    const items = [];

    blocks.forEach((block, bIdx) => {
        const lines = block.split('\n').map(l => l.trim()).filter(l => l);
        if (!lines.length) return;
        baskets.push(lines[0]);
        lines.slice(1).forEach(word => { items.push({ word, basket: bIdx }); });
    });

    if (items.length < 2) return alert('Слишком мало слов — под каждой корзиной нужно хотя бы одно слово!');

    const btn = document.getElementById('sorting-import-btn');
    btn.innerText = 'Создание...';
    btn.disabled = true;

    const { error } = await supabaseClient.from('sorting_exercises').insert([{
        test_key: state.activeSubjectKey,
        title: title,
        baskets: baskets,
        items: items
    }]);

    if (error) {
        alert('Ошибка при создании задания');
        btn.innerText = 'Создать задание';
        btn.disabled = false;
    } else {
        alert(`Задание создано: ${baskets.length} корзин, ${items.length} слов`);
        window.openSubjectManager(state.activeSubjectKey);
    }
};

window.deleteSortingExercise = async function(id) {
    if (!confirm('Удалить это задание на сортировку?')) return;
    await supabaseClient.from('sorting_exercises').delete().eq('id', id);
    window.openSubjectManager(state.activeSubjectKey);
};

function renderSubjectQuestionsList() {
    const isSuperadmin = state.currentUser.role === 'superadmin';
    document.getElementById('subject-editor-title').innerText = `Вопросы: ${getTestTitle(state.activeSubjectKey)} (${state.adminQuestions.length})`;
    
    let html = '';
    if (isSuperadmin) {
        html += `
        <div class="card" style="box-shadow:none; border:2px dashed #d7dce3; margin-bottom:20px; background:#f8fafc;">
            <h3 style="margin-top:0;">⚡ Быстрый импорт вопросов</h3>
            <input id="import-part-name" type="text" placeholder="Название части" value="Основная часть" style="width:100%; padding:8px; border-radius:8px; border:1px solid #ccc; margin-bottom:10px;">
            <textarea id="import-text" style="width:100%; height:100px; padding:10px; border-radius:8px; border:1px solid #ccc; font-family:monospace;" placeholder="+++++ Вопрос 1...\\n==== Неверный\\n====# Верный..."></textarea>
            <button id="import-btn" class="btn-ok" style="margin-top:10px; width:auto; padding:8px 20px;" onclick="window.parseAndImportQuestions()">Импортировать вопросы</button>
        </div>
        <div class="card" style="box-shadow:none; border:2px dashed #8b5cf6; margin-bottom:20px; background:#faf5ff;">
            <h3 style="margin-top:0;">🗂️ Задания на сортировку по корзинам</h3>
            <div class="muted" style="margin-bottom:10px; text-align:left;">Формат: первая строка блока — название корзины, дальше слова этой корзины по одному на строке. Блоки разделяются строкой из пяти плюсов (+++++). Минимум 2 корзины.</div>
            <input id="sorting-title" type="text" placeholder="Название задания (напр: Виды рыночных структур)" style="width:100%; padding:8px; border-radius:8px; border:1px solid #ccc; margin-bottom:10px;">
            <textarea id="sorting-import-text" style="width:100%; height:160px; padding:10px; border-radius:8px; border:1px solid #ccc; font-family:monospace;" placeholder="Монополия
слово1
слово2
+++++
Олигополия
слово3
слово4"></textarea>
            <button id="sorting-import-btn" class="btn-ok" style="margin-top:10px; width:auto; padding:8px 20px; background:#8b5cf6;" onclick="window.importSortingExercise()">Создать задание</button>

            ${state.adminSortingExercises.length ? `
                <div style="margin-top:20px;">
                    <h4 style="margin-bottom:10px; text-align:left;">Существующие задания:</h4>
                    ${state.adminSortingExercises.map(ex => `
                        <div style="display:flex; justify-content:space-between; align-items:center; padding:10px; background:#fff; border-radius:8px; border:1px solid #e2d9f5; margin-bottom:8px; flex-wrap:wrap; gap:10px;">
                            <span>${escapeHtml(ex.title)} <span class="muted" style="font-size:12px;">(${(ex.baskets || []).length} корзин, ${(ex.items || []).length} слов)</span></span>
                            <button class="btn-bad" style="margin:0; width:auto; padding:6px 12px; font-size:12px;" onclick="window.deleteSortingExercise(${ex.id})">❌ Удалить</button>
                        </div>
                    `).join('')}
                </div>
            ` : ''}
        </div>
        <div style="margin-bottom: 15px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
            <button class="btn-primary" style="margin:0; width:auto; padding:10px 20px;" onclick="window.openQuestionEditor(null)">+ Создать 1 вопрос вручную</button>
            <button class="btn-gray" style="margin:0; width:auto; padding:10px 20px;" onclick="window.splitQuestionsIntoParts()">✂️ Разделить на части</button>
            <button class="btn-bad" style="margin:0; width:auto; padding:10px 20px;" onclick="window.deleteSelectedQuestions()">🗑 Удалить выбранные</button>
            
            <label style="cursor:pointer; display:flex; align-items:center; gap:8px; margin-left: auto; font-size:14px; background: #f1f5f9; padding: 8px 15px; border-radius: 8px; border: 1px solid #cbd5e1;">
                <input type="checkbox" style="margin:0; width:16px; height:16px;" onchange="window.toggleAllCheckboxes(this, 'question-checkbox')">
                <b>Выбрать все</b>
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
                ${(isSuperadmin || state.currentUser.role === 'admin') ? `
                <div style="margin-top: 12px; display:flex; gap:10px;">
                    <button class="btn-gray" style="padding:8px; width:auto; font-size:13px;" onclick="window.openQuestionEditor(${q.id})">✏️ Редактировать</button>
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

window.openQuestionEditor = function(id) {
    if (state.currentUser.role !== 'admin' && state.currentUser.role !== 'superadmin') {
        return alert('⛔ У вас нет прав на редактирование вопросов.');
    }

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
            <input id="edit-q-part" type="text" value="${escapeHtml(qPart)}" style="width:100%; padding:8px; margin-top:5px; margin-bottom:15px; border-radius:8px; border:1px solid #ccc;">
            
            <label><strong>Текст вопроса:</strong></label>
            <textarea id="edit-q-text" style="width:100%; height:80px; padding:10px; margin-top:5px; border-radius:8px; border:1px solid #ccc;">${escapeHtml(qText)}</textarea>
            
            <div style="margin-top:15px;"><strong>Варианты ответа (отметьте правильный):</strong></div>
            <div id="edit-answers-list"></div>
            
            <button class="btn-gray" style="margin-top:10px; width:auto; padding:8px 15px;" onclick="window.addAnswerField()">+ Добавить вариант</button>
            <div style="margin-top: 20px; display:flex; gap:10px;">
                <button class="btn-ok" onclick="window.saveQuestion()">Сохранить</button>
                <button class="btn-gray" onclick="window.cancelQuestionEdit()">Отмена</button>
            </div>
        </div>
    `;
    window._tempAnswers = answers; 
    window._tempCorrect = correctIdx;
    window.renderAnswerFields();
};

window.renderAnswerFields = function() {
    const container = document.getElementById('edit-answers-list');
    container.innerHTML = window._tempAnswers.map((ans, i) => `
        <div style="display:flex; align-items:center; gap:10px; margin-top:8px;">
            <input type="radio" name="correct_answer" value="${i}" ${i === window._tempCorrect ? 'checked' : ''} style="width:20px; height:20px; margin:0;" onchange="window._tempCorrect = ${i}">
            <input type="text" class="edit-ans-input" value="${escapeHtml(ans)}" placeholder="Вариант ответа" style="margin:0; flex:1;" onchange="window._tempAnswers[${i}] = this.value">
            <button class="btn-bad" style="width:auto; padding:8px; margin:0;" onclick="window.removeAnswerField(${i})">X</button>
        </div>
    `).join('');
};

window.addAnswerField = function() { 
    window._tempAnswers.push(''); 
    window.renderAnswerFields(); 
};

window.removeAnswerField = function(idx) {
    if (window._tempAnswers.length <= 2) { alert('Минимум 2 варианта ответа!'); return; }
    window._tempAnswers.splice(idx, 1);
    if (window._tempCorrect >= window._tempAnswers.length) window._tempCorrect = 0;
    window.renderAnswerFields();
};

window.cancelQuestionEdit = function() {
    document.getElementById('question-form-container').classList.add('hidden');
    document.getElementById('questions-list-render').classList.remove('hidden');
};

window.saveQuestion = async function() {
    if (state.currentUser.role !== 'admin' && state.currentUser.role !== 'superadmin') {
        return alert('⛔ У вас нет прав на редактирование вопросов.');
    }

    const qPart = document.getElementById('edit-q-part').value.trim() || 'Основная часть';
    const qText = document.getElementById('edit-q-text').value.trim();
    const inputs = document.querySelectorAll('.edit-ans-input');
    const answers = Array.from(inputs).map(inp => inp.value.trim());
    
    if (!qText) { alert('Введите текст вопроса!'); return; }
    if (answers.some(a => !a)) { alert('Заполните все варианты ответов!'); return; }

    const payload = { test_key: state.activeSubjectKey, part_name: qPart, q: qText, a: answers, c: window._tempCorrect };
    document.getElementById('question-form-container').innerHTML = '<h3>Сохранение...</h3>';

    if (state.editingQuestionId) {
        await supabaseClient.from('questions').update(payload).eq('id', state.editingQuestionId);
    } else {
        await supabaseClient.from('questions').insert([payload]);
    }
    window.openSubjectManager(state.activeSubjectKey);
};

// ==========================================
// ЛОГИКА ЛАЙВ МОНИТОРИНГА
// ==========================================

window.startLiveTracking = async function() {
    const testKey = document.getElementById('live-test-select').value;
    const dashboard = document.getElementById('live-dashboard');
    if (!testKey) { dashboard.innerHTML = ''; return; }

    dashboard.innerHTML = '<div class="muted">Ожидание ответов...</div>';
    liveStats = {}; 
    
    const { data } = await supabaseClient.from('student_q_state').select('username, is_correct').eq('test_key', testKey);
    
    if (data) { 
        data.forEach(row => updateLiveStat(row.username, row.is_correct)); 
        renderLiveDashboard(); 
    }
    
    if (liveSubscription) {
        supabaseClient.removeChannel(liveSubscription);
    }

    liveSubscription = supabaseClient.channel('public:student_q_state')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'student_q_state', filter: `test_key=eq.${testKey}` }, payload => {
            updateLiveStat(payload.new.username, payload.new.is_correct); 
            renderLiveDashboard(); 
            highlightStudent(payload.new.username);
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'student_q_state', filter: `test_key=eq.${testKey}` }, payload => {
            updateLiveStat(payload.new.username, payload.new.is_correct, payload.old.is_correct); 
            renderLiveDashboard(); 
            highlightStudent(payload.new.username);
        })
        .subscribe();
};

function updateLiveStat(username, isCorrect, oldIsCorrect = null) {
    if (!liveStats[username]) liveStats[username] = { correct: 0, wrong: 0, total: 0 };
    
    if (oldIsCorrect !== null) {
        if (oldIsCorrect === true) liveStats[username].correct--;
        if (oldIsCorrect === false) liveStats[username].wrong--;
    } else { 
        liveStats[username].total++; 
    }
    
    if (isCorrect === true) liveStats[username].correct++;
    if (isCorrect === false) liveStats[username].wrong++;
}

function renderLiveDashboard() {
    const dashboard = document.getElementById('live-dashboard');
    if (Object.keys(liveStats).length === 0) return;
    
    dashboard.innerHTML = Object.keys(liveStats).sort((a, b) => liveStats[b].correct - liveStats[a].correct).map(username => {
        const stat = liveStats[username];
        return `
            <div id="live-card-${escapeHtml(username)}" class="card" style="margin-top:0; padding:15px; border:2px solid transparent; transition: border-color 0.3s; text-align: left;">
                <h3 style="margin:0 0 10px 0; font-size:18px;">👤 ${escapeHtml(username)}</h3>
                <div style="font-size: 14px;">
                    <span style="color: green; font-weight:bold;">✅ Правильных: ${stat.correct}</span><br>
                    <span style="color: red; font-weight:bold;">❌ Ошибок: ${stat.wrong}</span><br>
                    <span style="color: gray;">📊 Всего ответов: ${stat.correct + stat.wrong}</span>
                </div>
            </div>`;
    }).join('');
}

function highlightStudent(username) {
    const card = document.getElementById(`live-card-${username}`);
    if (card) { 
        card.style.borderColor = '#1368CE'; 
        setTimeout(() => { card.style.borderColor = 'transparent'; }, 500); 
    }
}

// ==========================================
// УПРАВЛЕНИЕ АДМИН ПАНЕЛЬЮ
// ==========================================

window.banIP = async function(ip) {
    if (!ip || ip === 'Скрыт/VPN') return;
    if (!confirm(`Заблокировать IP: ${ip}?`)) return;
    await supabaseClient.from('banned_ips').insert([{ ip_address: ip }]);
    await refreshAdminSlice(['bannedIps']);
};

window.unbanIP = async function(id) { 
    await supabaseClient.from('banned_ips').delete().eq('id', id); 
    await refreshAdminSlice(['bannedIps']);
};

window.toggleAccessMode = function() {
    const mode = document.querySelector('input[name="access_type"]:checked').value;
    document.getElementById('access-mode-group').classList.toggle('hidden', mode !== 'group');
    document.getElementById('access-mode-individual').classList.toggle('hidden', mode === 'group');
};

window.renderStudentsCheckboxes = function() {
    const container = document.getElementById('students-list');
    if (!container) return;
    
    const students = state.adminUsers.filter(u => u.role === 'student');
    if (!students.length) { 
        container.innerHTML = '<div class="muted" style="margin:0;">Студентов пока нет.</div>'; 
    } else {
        container.innerHTML = students.map(user => `
            <label class="student-item" style="display:block; margin-bottom:5px;">
                <input type="checkbox" value="${escapeHtml(user.username)}" class="student-checkbox">
                <span>${escapeHtml(user.username)} ${user.group_name !== 'Без группы' ? `<span style="color:#888; font-size:12px;">[${escapeHtml(user.group_name)}]</span>` : ''}</span>
            </label>
        `).join('');
    }
};

window.selectAllCheckboxes = function() { document.querySelectorAll('.student-checkbox').forEach(cb => cb.checked = true); };
window.deselectAllCheckboxes = function() { document.querySelectorAll('.student-checkbox').forEach(cb => cb.checked = false); };

window.grantAccess = async function() {
    const testKey = document.getElementById('access-test').value;
    const startRaw = document.getElementById('access-start').value;
    const endRaw = document.getElementById('access-end').value;
    const maxAttempts = parseInt(document.getElementById('access-attempts').value) || 1;

    if (!startRaw || !endRaw) { alert('Заполните поля даты и времени'); return; }

    const mode = document.querySelector('input[name="access_type"]:checked').value;
    let usernames = [];

    if (mode === 'group') {
        const selectedGroup = document.getElementById('access-group-select').value;
        usernames = state.adminUsers.filter(u => u.role === 'student' && u.group_name === selectedGroup).map(u => u.username);
        if(usernames.length === 0) return alert('В выбранной группе нет студентов!');
    } else {
        const checkboxes = document.querySelectorAll('.student-checkbox:checked');
        usernames = Array.from(checkboxes).map(cb => cb.value);
        if(usernames.length === 0) return alert('Выберите хотя бы одного студента');
    }

    const start = new Date(startRaw).toISOString();
    const end = new Date(endRaw).toISOString();

    // Было: 2 запроса на КАЖДОГО студента последовательно (delete+insert).
    // Стало: 1 delete + 1 insert на всю группу разом.
    await supabaseClient.from('test_access').delete().eq('test_key', testKey).in('username', usernames);

    const payloads = usernames.map(username => ({
        username,
        test_key: testKey,
        start_time: start,
        end_time: end,
        is_active: true,
        max_attempts: maxAttempts,
        used_attempts: 0
    }));

    const { error } = await supabaseClient.from('test_access').insert(payloads);
    if (error) {
        // Защита, если в базе еще нет колонок attempts
        const legacyPayloads = payloads.map(({ max_attempts, used_attempts, ...rest }) => rest);
        await supabaseClient.from('test_access').insert(legacyPayloads);
    }
    
    alert(`Доступ открыт для ${usernames.length} студентов`);
    await refreshAdminSlice(['accesses']);
};

window.createUser = async function() {
    const username = document.getElementById('new-username').value.trim();
    const password = document.getElementById('new-password').value.trim();
    const role = document.getElementById('new-role').value;
    let groupName = role === 'student' ? document.getElementById('new-group').value : 'Без группы';
    
    if (!username || !password) { alert('Заполните логин и пароль'); return; }
    
    const { error } = await supabaseClient.from('users').insert([{ username, password, role, group_name: groupName }]);
    if (error) {
        alert('Ошибка создания пользователя (возможно логин занят)');
    } else { 
        alert('Пользователь создан'); 
        await refreshAdminSlice(['users']);
    }
};

window.deleteUser = async function(id) { 
    if (!confirm('Удалить пользователя?')) return; 
    await supabaseClient.from('users').delete().eq('id', id); 
    await refreshAdminSlice(['users']);
};

window.deleteAccess = async function(id) { 
    if (!confirm('Удалить доступ?')) return; 
    await supabaseClient.from('test_access').delete().eq('id', id); 
    await refreshAdminSlice(['accesses']);
};

window.deleteResult = async function(id) { 
    if (!confirm('Удалить этот результат?')) return; 
    await supabaseClient.from('results').delete().eq('id', id); 
    await refreshAdminSlice(['results']);
};

window.filterTableRows = function(rowClassName, selectedKey) {
    document.querySelectorAll('.' + rowClassName).forEach(row => { 
        row.style.display = (selectedKey === 'all' || row.dataset.filterKey === selectedKey) ? '' : 'none'; 
    });
};

async function openAdminPanel() {
    showScreen('screen-admin');
    await syncSubjects();
    
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
    
    state.adminUsers = usersRes.data || [];
    state.adminResults = resultsRes.data || [];
    state.adminAccesses = accessRes.data || [];
    state.adminHistory = historyRes.data || [];
    state.adminBannedIps = bannedRes.data || [];
    state.adminGroups = groupsRes.data || [];

    renderAdminPanel();
}

// Точечное обновление одного или нескольких срезов данных админ-панели,
// без повторной загрузки всего остального (users/results/accesses/history/
// bannedIps/groups). Использует ту же логику запросов, что openAdminPanel.
async function refreshAdminSlice(keys) {
    const now = new Date().toISOString();
    const fetchers = {
        users: () => supabaseClient.from('users').select('*').order('id', { ascending: true }),
        results: () => supabaseClient.from('results').select('*').order('id', { ascending: false }),
        accesses: () => supabaseClient.from('test_access').select('*').gte('end_time', now).order('id', { ascending: false }),
        history: () => supabaseClient.from('login_history').select('*').order('login_time', { ascending: false }).limit(200),
        bannedIps: () => supabaseClient.from('banned_ips').select('*').order('banned_at', { ascending: false }),
        groups: () => supabaseClient.from('groups').select('*').order('name', { ascending: true })
    };
    const stateKeyMap = {
        users: 'adminUsers', results: 'adminResults', accesses: 'adminAccesses',
        history: 'adminHistory', bannedIps: 'adminBannedIps', groups: 'adminGroups'
    };
    const responses = await Promise.all(keys.map(k => fetchers[k]()));
    keys.forEach((k, i) => { state[stateKeyMap[k]] = responses[i].data || []; });
    renderAdminPanel();
}

function renderAdminPanel() {
    const users = state.adminUsers;
    const results = state.adminResults;
    const accesses = state.adminAccesses;
    const history = state.adminHistory;
    const bannedIps = state.adminBannedIps;
    const groups = state.adminGroups;
    showScreen('screen-admin');
    
    const isSuperadmin = state.currentUser.role === 'superadmin';

    const subjectsGrid = Object.keys(TEST_TITLES).map(key => `
        <div class="card" style="box-shadow:none; border:1px solid #d7dce3; margin-top:10px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; padding:15px;">
            <div>
                <div style="font-weight:bold; font-size:16px;">${escapeHtml(TEST_TITLES[key])}</div>
                <div style="font-size:12px; color:#888;">Ключ: ${escapeHtml(key)}</div>
            </div>
            <div style="display:flex; gap:10px; flex-wrap:wrap;">
                <button class="btn-primary" style="margin:0; padding:8px 15px; font-size:13px;" onclick="window.openSubjectManager('${jsAttr(key)}')">Вопросы</button>
                ${isSuperadmin ? `
                <button class="btn-gray" style="margin:0; padding:8px 15px; font-size:13px;" onclick="window.renameSubject('${jsAttr(key)}')">✏️ Название</button>
                <button class="btn-bad" style="margin:0; padding:8px 15px; font-size:13px;" onclick="window.deleteSubject('${jsAttr(key)}')">❌ Удалить</button>
                ` : ''}
            </div>
        </div>
    `).join('');

    const groupsRows = groups.length ? groups.map(g => `
        <tr>
            <td>${escapeHtml(g.name)}</td>
            <td>
                <button class="btn-ok" style="padding:6px 12px; width:auto; font-size:12px; margin-right:5px;" onclick="window.openGroupManager('${jsAttr(g.name)}')">👥 Состав группы</button>
                <button class="btn-bad" style="padding:6px 12px; width:auto; font-size:12px;" onclick="window.deleteGroup(${g.id}, '${jsAttr(g.name)}')">❌ Удалить</button>
            </td>
        </tr>
    `).join('') : `<tr><td colspan="2">Групп пока нет</td></tr>`;

    const visibleUsers = isSuperadmin ? users : users.filter(u => u.role === 'student' || u.username === state.currentUser.username);
    const userRows = visibleUsers.length ? visibleUsers.map(user => {
        let canDel = (isSuperadmin && user.username !== state.currentUser.username) || (!isSuperadmin && user.role === 'student');
        return `
            <tr>
                <td>${escapeHtml(user.id)}</td>
                <td>${escapeHtml(user.username)}</td>
                <td>${escapeHtml(user.password)}</td>
                <td>${escapeHtml(user.role)}</td>
                <td>${escapeHtml(user.group_name || 'Без группы')}</td>
                <td>${canDel ? `<button class="btn-bad" style="padding:10px; width:auto;" onclick="window.deleteUser(${user.id})">❌</button>` : ''}</td>
            </tr>
        `;
    }).join('') : `<tr><td colspan="6">Пользователей пока нет</td></tr>`;

    let roleOptions = `<option value="student">student (Студент)</option>`;
    if (isSuperadmin) roleOptions += `<option value="admin">admin (Обычный Админ)</option><option value="superadmin">superadmin (Главный Админ)</option>`;
    const groupSelectOptions = `<option value="Без группы">Без группы</option>` + groups.map(g => `<option value="${escapeHtml(g.name)}">${escapeHtml(g.name)}</option>`).join('');

    const accessRows = accesses.length ? accesses.map(row => `
        <tr class="access-row" data-filter-key="${escapeHtml(row.test_key)}">
            <td>${escapeHtml(row.username)}</td>
            <td>${escapeHtml(getTestTitle(row.test_key))}</td>
            <td>${new Date(row.start_time).toLocaleString()}</td>
            <td>${new Date(row.end_time).toLocaleString()}</td>
            <td><b>${row.used_attempts || 0} / ${row.max_attempts || 1}</b></td>
            <td><button class="btn-bad" style="padding:10px; width:auto;" onclick="window.deleteAccess(${row.id})">❌</button></td>
        </tr>
    `).join('') : `<tr><td colspan="6">Нет активных доступов</td></tr>`;

    const completedResults = results.filter(r => r.status !== 'incomplete');
    const incompleteResults = results.filter(r => r.status === 'incomplete');

    // Новые результаты хранят test_key напрямую; старые (до этого поля)
    // определяем по названию теста, как и раньше.
    const resolveResultTestKey = (row) => {
        if (row.test_key) return row.test_key;
        const baseName = row.test_name.match(/^(.*?) \(/) ? row.test_name.match(/^(.*?) \(/)[1] : row.test_name;
        return Object.keys(TEST_TITLES).find(k => TEST_TITLES[k] === baseName) || 'unknown';
    };

    const resultRows = completedResults.length ? completedResults.map(row => {
        const testKey = resolveResultTestKey(row);
        return `
        <tr class="result-row" data-filter-key="${escapeHtml(testKey)}">
            <td><input type="checkbox" class="result-checkbox" value="${row.id}"></td>
            <td>${escapeHtml(row.id)}</td>
            <td>${escapeHtml(row.username)}</td>
            <td>${escapeHtml(row.test_name)}</td>
            <td>${escapeHtml(row.score)}/${escapeHtml(row.total)}</td>
            <td>${escapeHtml(row.percentage)}%</td>
            <td><button class="btn-bad" style="padding:10px; width:auto;" onclick="window.deleteResult(${row.id})">❌</button></td>
        </tr>`
    }).join('') : `<tr><td colspan="7">Завершенных результатов пока нет</td></tr>`;

    const incompleteRows = incompleteResults.length ? incompleteResults.map(row => {
        const testKey = resolveResultTestKey(row);
        return `
        <tr class="incomplete-row" data-filter-key="${escapeHtml(testKey)}">
            <td><input type="checkbox" class="incomplete-checkbox" value="${row.id}"></td>
            <td>${escapeHtml(row.id)}</td>
            <td>${escapeHtml(row.username)}</td>
            <td>${escapeHtml(row.test_name)}</td>
            <td>${escapeHtml(row.score)} (до выхода)</td>
            <td><button class="btn-bad" style="padding:10px; width:auto;" onclick="window.deleteResult(${row.id})">❌</button></td>
        </tr>`
    }).join('') : `<tr><td colspan="6">Незавершенных тестов нет</td></tr>`;

    const visibleHistory = isSuperadmin ? history : history.filter(h => {
        const u = users.find(user => user.username === h.username);
        return (!u) || u.role === 'student' || h.username === state.currentUser.username;
    });

    const historyRows = visibleHistory.length ? visibleHistory.map(row => {
        let banBtn = (isSuperadmin && row.ip_address !== 'Скрыт/VPN') ? `<button class="btn-bad" style="padding:4px 8px; font-size:12px; margin-left:10px; width:auto;" onclick="window.banIP('${jsAttr(row.ip_address)}')">⛔ Бан</button>` : '';
        return `
            <tr class="history-row" data-filter-key="${escapeHtml(row.username)}">
                <td>${escapeHtml(row.username)}</td>
                <td>${escapeHtml(row.ip_address)} ${banBtn}</td>
                <td>${new Date(row.login_time).toLocaleString()}</td>
            </tr>
        `;
    }).join('') : `<tr><td colspan="3">Истории входов пока нет</td></tr>`;

    const bannedRows = bannedIps.length ? bannedIps.map(row => `
        <tr>
            <td style="color:red; font-weight:bold;">${escapeHtml(row.ip_address)}</td>
            <td>${new Date(row.banned_at).toLocaleString()}</td>
            <td><button class="btn-ok" style="padding:8px 15px; width:auto;" onclick="window.unbanIP(${row.id})">Разблокировать</button></td>
        </tr>
    `).join('') : `<tr><td colspan="3">Черный список пуст</td></tr>`;

    screenAdmin.innerHTML = `
        <div class="screen-top">
            <div class="left">
                <h1 class="title-left">Админ-панель</h1>
                <div class="subtitle-left">Статус: ${isSuperadmin ? 'Главный Администратор' : 'Администратор'} | ${escapeHtml(state.currentUser.username)}</div>
            </div>
            <div class="right">
                <button class="ql-mini-button" onclick="window.openKahootMenu()">🎮 Kahoot-режим</button>
                <button class="btn-gray" onclick="openAdminPanel()">🔄 Обновить</button>
                <button class="btn-gray" onclick="window.changeMyPassword()">🔑 Пароль</button>
                <button class="btn-bad" onclick="window.logout()">🚪 Выйти</button>
            </div>
        </div>
        
        <div class="admin-tabs" style="display:flex; flex-wrap:wrap;">
            <button id="btn-subjects" class="tab-btn" onclick="window.switchAdminTab('subjects')">Предметы</button>
            <button id="btn-students" class="tab-btn" onclick="window.switchAdminTab('students')">Пользователи</button>
            <button id="btn-exams" class="tab-btn" onclick="window.switchAdminTab('exams')">Экзамены</button>
            <button id="btn-results" class="tab-btn" onclick="window.switchAdminTab('results')">Результаты</button>
            <button id="btn-incomplete" class="tab-btn" onclick="window.switchAdminTab('incomplete')">Незавершенные</button>
            <button id="btn-history" class="tab-btn" onclick="window.switchAdminTab('history')">История</button>
            <button id="btn-live" class="tab-btn" style="background:#f59e0b; color:white;" onclick="window.switchAdminTab('live')">🔴 LIVE</button>
            ${isSuperadmin ? `<button id="btn-blacklist" class="tab-btn" style="color: red;" onclick="window.switchAdminTab('blacklist')">Бан-лист</button>` : ''}
        </div>
        
        <div id="tab-subjects" class="tab-content admin-section">
            <div id="subjects-list-container">
                <h2>Управление предметами</h2>
                ${isSuperadmin ? `
                <div class="card" style="box-shadow:none; padding:15px; margin-bottom:20px;">
                    <h3 style="margin-top:0;">Добавить новый предмет</h3>
                    <div style="display:flex; gap:10px; flex-wrap:wrap;">
                        <input id="new-subj-title" placeholder="Название предмета (напр: Экономика)" style="margin:0; flex:1;" />
                        <input id="new-subj-key" placeholder="Системный ключ (англ., напр: economics)" style="margin:0; flex:1;" />
                        <button class="btn-ok" style="margin:0; width:auto; padding: 0 20px;" onclick="window.createSubject()">Создать</button>
                    </div>
                </div>
                ` : ''}
                <div style="margin-top:15px;">${subjectsGrid}</div>
            </div>
            <div id="subject-editor-container" class="hidden">
                <button class="btn-gray" style="margin-bottom:15px; width:auto; padding: 10px 20px;" onclick="window.closeSubjectManager()">🔙 Назад к списку</button>
                <h2 id="subject-editor-title" style="text-align:left;">Управление вопросами</h2>
                <div id="question-form-container" class="hidden"></div>
                <div id="questions-list-render"></div>
            </div>
        </div>
        
        <div id="tab-live" class="tab-content admin-section">
            <h2>🔴 Лайв мониторинг (Kahoot режим)</h2>
            <div class="muted">Ответы студентов появляются здесь в реальном времени.</div>
            <select id="live-test-select" style="margin-bottom: 20px;" onchange="window.startLiveTracking()">
                <option value="">Выберите предмет для слежения...</option>
                ${Object.keys(TEST_TITLES).map(key => `<option value="${escapeHtml(key)}">${escapeHtml(TEST_TITLES[key])}</option>`).join('')}
            </select>
            <div id="live-dashboard" class="grid" style="grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 15px;"></div>
        </div>

        <div id="tab-students" class="tab-content admin-section">
            <div id="students-main-view">
                <h2>Управление группами</h2>
                <div style="display:flex; gap:10px; margin-bottom: 15px;">
                    <input id="new-group-input" placeholder="Название новой группы" style="margin:0;" />
                    <button class="btn-ok" style="margin:0; width:auto; padding: 0 20px;" onclick="window.createGroup()">Добавить</button>
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
                    <button class="btn-ok" style="margin-top: 15px;" onclick="window.createUser()">Создать</button>
                </div>
                
                <h2>Список пользователей</h2>
                <div class="table-wrap"><table><tr><th>ID</th><th>Логин</th><th>Пароль</th><th>Роль</th><th>Группа</th><th>Удалить</th></tr>${userRows}</table></div>
            </div>
            
            <div id="group-editor-view" class="hidden">
                <button class="btn-gray" style="margin-bottom:15px; width:auto; padding: 10px 20px;" onclick="window.closeGroupManager()">🔙 Назад</button>
                <h2 id="group-editor-title">Состав группы</h2>
                <div id="group-members-list" class="table-wrap" style="margin-bottom:20px;"></div>
                <div class="card" style="box-shadow:none; border:1px solid #d7dce3;">
                    <h3 style="margin-top:0;">Добавить студента в группу</h3>
                    <div style="display:flex; gap:10px;">
                        <select id="add-to-group-select" style="margin:0;"></select>
                        <button class="btn-ok" style="margin:0; width:auto; padding:0 20px;" onclick="window.addUserToGroup()">Добавить</button>
                    </div>
                </div>
            </div>
        </div>
        
        <div id="tab-exams" class="tab-content admin-section">
            <div class="card" style="box-shadow:none; margin-top:0; padding:0; margin-bottom: 20px;">
                <h2>Открыть доступ к экзамену</h2>
                <select id="access-test" style="margin-bottom:20px;">
                    ${Object.keys(TEST_TITLES).map(key => `<option value="${escapeHtml(key)}">${escapeHtml(TEST_TITLES[key])}</option>`).join('')}
                </select>
                
                <div style="display:flex; gap:20px; margin-bottom:15px; background: #f9fafb; padding:10px; border-radius:8px;">
                    <label style="cursor:pointer;"><input type="radio" name="access_type" value="group" checked onchange="window.toggleAccessMode()"> <b>Группе целиком</b></label>
                    <label style="cursor:pointer;"><input type="radio" name="access_type" value="individual" onchange="window.toggleAccessMode()"> <b>Выбрать индивидуально</b></label>
                </div>

                <div id="access-mode-group">
                    <select id="access-group-select">${groupSelectOptions}</select>
                </div>

                <div id="access-mode-individual" class="hidden">
                    <div id="students-list" class="students-list" style="max-height: 200px; overflow-y: auto; border: 1px solid #d7dce3; padding: 10px; border-radius: 8px;"></div>
                    <div style="margin-top:10px;">
                        <button class="btn-gray" style="padding:5px 10px; font-size:12px; width:auto;" onclick="window.selectAllCheckboxes()">✅ Выбрать всех</button> 
                        <button class="btn-gray" style="padding:5px 10px; font-size:12px; width:auto;" onclick="window.deselectAllCheckboxes()">❌ Снять выделение</button>
                    </div>
                </div>
                
                <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:20px;">
                    <div style="flex:1;"><label>Начало доступа</label><input id="access-start" type="datetime-local"></div>
                    <div style="flex:1;"><label>Конец доступа</label><input id="access-end" type="datetime-local"></div>
                    <div style="flex:1;"><label>Кол-во попыток</label><input id="access-attempts" type="number" value="1" min="1"></div>
                </div>
                
                <button class="btn-ok" style="margin-top:15px;" onclick="window.grantAccess()">Открыть доступ</button>
            </div>
            
            <h2>Активные доступы</h2>
            <select id="filter-access" onchange="window.filterTableRows('access-row', this.value)" style="margin-bottom: 15px;">
                <option value="all">Все предметы</option>
                ${Object.keys(TEST_TITLES).map(key => `<option value="${escapeHtml(key)}">${escapeHtml(TEST_TITLES[key])}</option>`).join('')}
            </select>
            <div class="table-wrap"><table><tr><th>Студент</th><th>Предмет</th><th>Начало</th><th>Конец</th><th>Попытки (Испол/Всего)</th><th>Удалить</th></tr>${accessRows}</table></div>
        </div>
        
        <div id="tab-results" class="tab-content admin-section">
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap;">
                <h2>Результаты тестов</h2>
                <button class="btn-bad" style="width:auto; padding:8px 15px; margin-bottom:15px;" onclick="window.deleteSelectedResults('completed')">🗑 Удалить выбранные</button>
            </div>
            <select id="filter-result" onchange="window.filterTableRows('result-row', this.value)" style="margin-bottom: 15px;">
                <option value="all">Все предметы</option>
                ${Object.keys(TEST_TITLES).map(key => `<option value="${escapeHtml(key)}">${escapeHtml(TEST_TITLES[key])}</option>`).join('')}
            </select>
            <div class="table-wrap"><table><tr><th><input type="checkbox" onchange="window.toggleAllCheckboxes(this, 'result-checkbox')"></th><th>ID</th><th>Пользователь</th><th>Тест</th><th>Баллы</th><th>%</th><th>Удалить</th></tr>${resultRows}</table></div>
        </div>

        <div id="tab-incomplete" class="tab-content admin-section">
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap;">
                <h2>Незавершенные тесты</h2>
                <button class="btn-bad" style="width:auto; padding:8px 15px; margin-bottom:15px;" onclick="window.deleteSelectedResults('incomplete')">🗑 Удалить выбранные</button>
            </div>
            <div class="muted" style="margin-bottom:15px; text-align:left;">Нажатие "Пауза/Назад" во время теста тратит 1 попытку и сохраняет баллы до выхода сюда.</div>
            <select id="filter-incomplete" onchange="window.filterTableRows('incomplete-row', this.value)" style="margin-bottom: 15px;">
                <option value="all">Все предметы</option>
                ${Object.keys(TEST_TITLES).map(key => `<option value="${escapeHtml(key)}">${escapeHtml(TEST_TITLES[key])}</option>`).join('')}
            </select>
            <div class="table-wrap"><table><tr><th><input type="checkbox" onchange="window.toggleAllCheckboxes(this, 'incomplete-checkbox')"></th><th>ID</th><th>Пользователь</th><th>Тест</th><th>Баллы на момент выхода</th><th>Удалить</th></tr>${incompleteRows}</table></div>
        </div>

        <div id="tab-history" class="tab-content admin-section">
            <h2>История авторизаций</h2>
            <select id="filter-history" onchange="window.filterTableRows('history-row', this.value)" style="margin-bottom: 15px;">
                <option value="all">Все пользователи</option>
                ${[...new Set(visibleHistory.map(u => u.username))].map(u => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join('')}
            </select>
            <div class="table-wrap"><table><tr><th>Пользователь</th><th>IP-адрес</th><th>Время входа</th></tr>${historyRows}</table></div>
        </div>

        ${isSuperadmin ? `
        <div id="tab-blacklist" class="tab-content admin-section">
            <h2 style="color:red;">Черный список IP-адресов</h2>
            <div class="table-wrap"><table><tr><th>IP-адрес</th><th>Дата блокировки</th><th>Действие</th></tr>${bannedRows}</table></div>
        </div>
        ` : ''}
    `;
    
    window.renderStudentsCheckboxes();
    window.switchAdminTab(currentAdminTab);
    if (state.activeGroupManager) window.openGroupManager(state.activeGroupManager);
}

// ==========================================
// QUIZ LIVE — живая игровая викторина по PIN-коду
// Использует отдельные таблицы и защищённые RPC в Supabase.
// ==========================================

let kahootSession = null;
let kahootRealtimeChannel = null;
let kahootClockTimer = null;
let kahootActionInProgress = false;
let kahootSyncInProgress = false;
let kahootSyncQueued = false;

function kahootRandomToken() {
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
        const bytes = new Uint8Array(32);
        window.crypto.getRandomValues(bytes);
        return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    }
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

function kahootFriendlyError(error) {
    const raw = String(error?.message || error || 'Неизвестная ошибка');
    const messages = [
        [/PIN_IN_USE|duplicate key value violates unique constraint.*kahoot_games_pin/i, 'Этот PIN уже используется. Попробуйте создать игру ещё раз.'],
        [/GAME_NOT_FOUND_OR_STARTED/i, 'Комната не найдена или ведущий уже начал игру. Проверьте PIN-код.'],
        [/GAME_NOT_FOUND/i, 'Игровая комната не найдена.'],
        [/NAME_TAKEN|kahoot_players_unique_name/i, 'Это имя уже занято в данной игре. Выберите другое.'],
        [/INVALID_HOST_TOKEN/i, 'Не удалось подтвердить права ведущего. Откройте сохранённую сессию ведущего.'],
        [/INVALID_PLAYER_TOKEN/i, 'Сессия игрока не подтверждена. Выйдите в меню и подключитесь заново.'],
        [/ALREADY_ANSWERED/i, 'Ответ на этот вопрос уже отправлен.'],
        [/ROUND_CLOSED/i, 'Время ответа истекло или ведущий уже закрыл вопрос.'],
        [/INVALID_GAME_PHASE/i, 'Это действие сейчас недоступно. Обновляем состояние игры.'],
        [/INVALID_PLAYER_NAME/i, 'Имя должно содержать от 1 до 24 символов.'],
        [/INVALID_QUESTION_DATA|ANSWER_KEY_MISSING/i, 'Не удалось подготовить вопросы для игры. Проверьте варианты ответов в тесте.'],
        [/KAHOOT_SECRET_NOT_INITIALIZED/i, 'Секреты игрового режима не созданы. Повторно проверьте выполнение kahoot_setup.sql в Supabase.'],
        [/permission denied|row-level security/i, 'Supabase запретил доступ. Проверьте, что SQL-миграция Quiz Live выполнена полностью.'],
        [/kahoot_(games|players|answers).*does not exist|function .*kahoot_.* does not exist/i, 'Не найдены таблицы или функции игрового режима. Сначала выполните kahoot_setup.sql в Supabase.']
    ];
    for (const [pattern, message] of messages) if (pattern.test(raw)) return message;
    return `Ошибка игрового режима: ${raw}`;
}

async function kahootRpc(name, params) {
    const { data, error } = await supabaseClient.rpc(name, params);
    if (error) throw new Error(kahootFriendlyError(error));
    return data;
}

function kahootCurrentUserName() {
    return state.currentUser?.username ? String(state.currentUser.username) : '';
}

function kahootIsAdministrator() {
    return !!state.currentUser && ['admin', 'superadmin'].includes(state.currentUser.role);
}

function kahootUrl(pin) {
    return `${window.location.origin}${window.location.pathname}#kahoot=${encodeURIComponent(pin)}`;
}

async function kahootCopy(text) {
    try {
        await navigator.clipboard.writeText(text);
        alert('Ссылка скопирована. Отправьте её участникам или покажите QR-код.');
    } catch (_) {
        window.prompt('Скопируйте ссылку на игру:', text);
    }
}

async function kahootStopRealtime() {
    if (kahootClockTimer) {
        clearInterval(kahootClockTimer);
        kahootClockTimer = null;
    }
    if (kahootRealtimeChannel && supabaseClient) {
        try { await supabaseClient.removeChannel(kahootRealtimeChannel); } catch (_) {}
        kahootRealtimeChannel = null;
    }
}

async function kahootConnectRealtime(gameId) {
    await kahootStopRealtime();
    kahootRealtimeChannel = supabaseClient.channel(`quiz-live-${gameId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'kahoot_games', filter: `id=eq.${gameId}` }, () => window.kahootSync())
        .on('postgres_changes', { event: '*', schema: 'public', table: 'kahoot_players', filter: `game_id=eq.${gameId}` }, () => window.kahootSync())
        .subscribe();
    kahootClockTimer = setInterval(kahootClockTick, 300);
    await window.kahootSync();
}

async function kahootGetAvailableTests() {
    await syncSubjects();
    const keys = Object.keys(TEST_TITLES);
    if (kahootIsAdministrator()) return keys.map(key => ({ key, title: TEST_TITLES[key] || key }));
    if (!state.currentUser?.username) return [];
    const now = new Date().toISOString();
    const { data, error } = await supabaseClient.from('test_access')
        .select('test_key')
        .eq('username', state.currentUser.username)
        .eq('is_active', true)
        .lte('start_time', now)
        .gte('end_time', now);
    if (error) throw new Error(kahootFriendlyError(error));
    const allowed = [...new Set((data || []).map(row => row.test_key))];
    return allowed.map(key => ({ key, title: TEST_TITLES[key] || key })).filter(row => row.key);
}

window.openKahootMenu = async function() {
    await kahootStopRealtime();
    kahootSession = null;
    showScreen('screen-kahoot');
    screenKahoot.innerHTML = `
        <div class="ql-shell">
            <div class="ql-nav">
                <div class="ql-brand"><span class="ql-brand-mark">Q</span><span>QUIZ LIVE</span></div>
                <button class="ql-nav-button" onclick="window.kahootBackToSite()">← Назад на сайт</button>
            </div>
            <section class="ql-hero">
                <div class="ql-eyebrow">LIVE QUIZ • MULTIPLAYER</div>
                <h1>Учитесь. Играйте. Побеждайте.</h1>
                <p>Создайте игровую комнату для группы или присоединитесь к ведущему по PIN-коду.</p>
                <div class="ql-hero-orbs" aria-hidden="true"><span>✦</span><span>●</span><span>▲</span><span>◆</span></div>
            </section>
            <div id="ql-menu-content" class="ql-menu-grid">
                <div class="ql-panel"><div class="ql-skeleton"></div><div class="ql-skeleton short"></div></div>
                <div class="ql-panel"><div class="ql-skeleton"></div><div class="ql-skeleton short"></div></div>
            </div>
            <p class="ql-footnote">Игровой режим сайта • ответы и очки синхронизируются в реальном времени</p>
        </div>`;

    const urlMatch = window.location.hash.match(/kahoot=(\d{6})/i);
    const pinFromLink = urlMatch ? urlMatch[1] : '';
    let testOptions = [];
    let loadError = '';
    if (state.currentUser) {
        try { testOptions = await kahootGetAvailableTests(); }
        catch (error) { loadError = error.message; }
    }
    const savedHost = (() => { try { return JSON.parse(localStorage.getItem('kahoot_host_session') || 'null'); } catch (_) { return null; } })();
    const savedPlayer = (() => { try { return JSON.parse(localStorage.getItem('kahoot_player_session') || 'null'); } catch (_) { return null; } })();
    const canHost = !!state.currentUser && testOptions.length > 0;
    const durationOptions = [10, 15, 20, 30, 60, 90].map(seconds => `<option value="${seconds}" ${seconds === 20 ? 'selected' : ''}>${seconds} секунд</option>`).join('');
    const testOptionsHtml = testOptions.map(item => `<option value="${escapeHtml(item.key)}">${escapeHtml(item.title)}</option>`).join('');

    document.getElementById('ql-menu-content').innerHTML = `
        ${canHost ? `
        <section class="ql-panel ql-host-panel">
            <div class="ql-panel-icon">✦</div>
            <div class="ql-panel-kicker">ДЛЯ ВЕДУЩЕГО</div>
            <h2>Создать игру</h2>
            <p>Выберите тест, настройте таймер и запустите общую викторину на экране.</p>
            <label for="ql-test-select">Тест / предмет</label>
            <select id="ql-test-select">${testOptionsHtml}</select>
            <label for="ql-duration-select">Время на ответ</label>
            <select id="ql-duration-select">${durationOptions}</select>
            <button class="ql-primary-button" onclick="window.kahootCreateGame()">＋ Создать игровую комнату</button>
        </section>` : `
        <section class="ql-panel ql-host-panel">
            <div class="ql-panel-icon">✦</div>
            <div class="ql-panel-kicker">ДЛЯ ВЕДУЩЕГО</div>
            <h2>Создать игру</h2>
            <p>${state.currentUser ? 'Сейчас нет доступных для вас тестов. Попросите администратора открыть доступ.' : 'Войдите на сайт, чтобы создать игру. Присоединиться по PIN можно без входа.'}</p>
            ${loadError ? `<div class="ql-error">${escapeHtml(loadError)}</div>` : ''}
            ${!state.currentUser ? `<button class="ql-secondary-button" onclick="window.kahootBackToSite()">Войти на сайт</button>` : ''}
        </section>`}
        <section class="ql-panel ql-join-panel">
            <div class="ql-panel-icon join">➜</div>
            <div class="ql-panel-kicker">ДЛЯ УЧАСТНИКА</div>
            <h2>Войти в игру</h2>
            <p>Введите шестизначный PIN-код с экрана ведущего.</p>
            <label for="ql-pin-input">PIN-код</label>
            <input id="ql-pin-input" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="Например, 483 219" value="${escapeHtml(pinFromLink)}" oninput="this.value=this.value.replace(/\\D/g,'').slice(0,6)">
            <label for="ql-name-input">Ваше имя</label>
            <input id="ql-name-input" maxlength="24" autocomplete="nickname" placeholder="Введите имя" value="${escapeHtml(kahootCurrentUserName())}">
            <button class="ql-primary-button ql-join-button" onclick="window.kahootJoinGame()">Войти и играть →</button>
            <div class="ql-small-note">Аккаунт не нужен. Имя будет видно ведущему и другим игрокам.</div>
        </section>
        ${(savedHost || savedPlayer) ? `
        <section class="ql-resume-card">
            <div><strong>У вас есть сохранённая игра</strong><span>Можно вернуться в комнату на этом устройстве.</span></div>
            <button class="ql-secondary-button" onclick="window.kahootResumeSaved()">Продолжить →</button>
        </section>` : ''}
    `;
    const pinInput = document.getElementById('ql-pin-input');
    if (pinInput && pinFromLink) pinInput.focus();
};

window.kahootBackToSite = async function() {
    await kahootStopRealtime();
    kahootSession = null;
    if (state.currentUser?.role === 'admin' || state.currentUser?.role === 'superadmin') await openAdminPanel();
    else if (state.currentUser) await window.renderSelection();
    else renderLogin();
};

window.kahootBackToMenu = async function() {
    const finishedSession = kahootSession?.game?.status === 'finished' ? kahootSession : null;
    await kahootStopRealtime();
    if (finishedSession?.role === 'host') localStorage.removeItem('kahoot_host_session');
    if (finishedSession?.role === 'player') localStorage.removeItem('kahoot_player_session');
    kahootSession = null;
    await window.openKahootMenu();
};

window.kahootCreateGame = async function() {
    if (!state.currentUser) return alert('Сначала войдите на сайт.');
    if (kahootActionInProgress) return;
    const testKey = document.getElementById('ql-test-select')?.value;
    const duration = Number(document.getElementById('ql-duration-select')?.value || 20);
    if (!testKey) return alert('Выберите тест.');
    kahootActionInProgress = true;
    try {
        const { data: rows, error } = await supabaseClient.from('questions')
            .select('id, test_key, q, a, c, part_name')
            .eq('test_key', testKey)
            .order('id', { ascending: true });
        if (error) throw new Error(kahootFriendlyError(error));
        const sourceRows = (rows || []).filter(row => Array.isArray(row.a) && row.a.length >= 2 &&
            Number.isInteger(Number(row.c)) && Number(row.c) >= 0 && Number(row.c) < row.a.length && String(row.q || '').trim());
        if (!sourceRows.length) throw new Error('В выбранном тесте нет вопросов с корректными вариантами ответов.');

        const prepared = shuffleArray(sourceRows).map(row => {
            const original = row.a.map((text, index) => ({ text: String(text), correct: index === Number(row.c) }));
            const correct = original.find(item => item.correct);
            let picked;
            if (original.length > 4) picked = [correct, ...shuffleArray(original.filter(item => !item.correct)).slice(0, 3)];
            else picked = original;
            const mixed = shuffleArray(picked);
            return { q: String(row.q), a: mixed.map(item => item.text), c: mixed.findIndex(item => item.correct) };
        });
        const questionsPublic = prepared.map(question => ({ q: question.q, a: question.a }));
        const answerKeys = prepared.map(question => question.c);
        const hostToken = kahootRandomToken();
        let created = null;
        let lastError = null;
        for (let attempt = 0; attempt < 5 && !created; attempt++) {
            const pin = String(Math.floor(100000 + Math.random() * 900000));
            try {
                created = await kahootRpc('kahoot_create_game', {
                    p_pin: pin,
                    p_title: TEST_TITLES[testKey] || testKey,
                    p_host_name: kahootCurrentUserName() || 'Ведущий',
                    p_test_key: testKey,
                    p_questions: questionsPublic,
                    p_answer_keys: answerKeys,
                    p_host_token: hostToken,
                    p_duration_seconds: duration
                });
            } catch (error) {
                lastError = error;
                if (!/PIN уже используется|PIN_IN_USE|duplicate key/i.test(error.message)) throw error;
            }
        }
        if (!created) throw lastError || new Error('Не удалось создать комнату.');
        const hostSession = {
            role: 'host', pin: created.pin, gameId: created.id, token: hostToken,
            title: created.title || TEST_TITLES[testKey] || testKey, testKey, questions: prepared, duration
        };
        localStorage.setItem('kahoot_host_session', JSON.stringify(hostSession));
        // Prevent an old participant session on this browser from being resumed by mistake.
        localStorage.removeItem('kahoot_player_session');
        kahootSession = { ...hostSession, game: null, players: [], roundResult: null, answerRows: [] };
        await kahootConnectRealtime(created.id);
    } catch (error) {
        alert(kahootFriendlyError(error));
    } finally {
        kahootActionInProgress = false;
    }
};

window.kahootJoinGame = async function() {
    if (kahootActionInProgress) return;
    const pin = String(document.getElementById('ql-pin-input')?.value || '').replace(/\D/g, '').slice(0, 6);
    const name = String(document.getElementById('ql-name-input')?.value || '').trim();
    if (!/^\d{6}$/.test(pin)) return alert('Введите шестизначный PIN-код.');
    if (!name || name.length > 24) return alert('Имя должно содержать от 1 до 24 символов.');
    kahootActionInProgress = true;
    try {
        const token = kahootRandomToken();
        const joined = await kahootRpc('kahoot_join_game', { p_pin: pin, p_player_name: name, p_player_token: token });
        const playerSession = { role: 'player', pin: joined.pin, gameId: joined.game_id, playerId: joined.player_id, token, name: joined.player_name };
        localStorage.setItem('kahoot_player_session', JSON.stringify(playerSession));
        localStorage.removeItem('kahoot_host_session');
        kahootSession = { ...playerSession, game: null, players: [], roundResult: null, myRoundAnswer: null };
        await kahootConnectRealtime(joined.game_id);
        try { window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`); } catch (_) {}
    } catch (error) {
        alert(kahootFriendlyError(error));
    } finally {
        kahootActionInProgress = false;
    }
};

window.kahootResumeSaved = async function() {
    if (kahootActionInProgress) return;
    kahootActionInProgress = true;
    try {
        const host = (() => { try { return JSON.parse(localStorage.getItem('kahoot_host_session') || 'null'); } catch (_) { return null; } })();
        const player = (() => { try { return JSON.parse(localStorage.getItem('kahoot_player_session') || 'null'); } catch (_) { return null; } })();
        if (host?.gameId && host?.token && Array.isArray(host.questions)) {
            kahootSession = { ...host, role: 'host', game: null, players: [], roundResult: null, answerRows: [] };
            await kahootConnectRealtime(host.gameId);
        } else if (player?.gameId && player?.playerId && player?.token) {
            kahootSession = { ...player, role: 'player', game: null, players: [], roundResult: null, myRoundAnswer: null };
            await kahootConnectRealtime(player.gameId);
        } else {
            alert('Сохранённая сессия не найдена. Подключитесь к игре заново.');
            await window.openKahootMenu();
        }
    } catch (error) {
        alert(kahootFriendlyError(error));
    } finally {
        kahootActionInProgress = false;
    }
};

window.kahootSync = async function() {
    if (!kahootSession?.gameId) return;
    if (kahootSyncInProgress) { kahootSyncQueued = true; return; }
    kahootSyncInProgress = true;
    try {
        const oldQuestionIndex = kahootSession.game?.question_index;
        const { data: game, error: gameError } = await supabaseClient.from('kahoot_games').select('*').eq('id', kahootSession.gameId).maybeSingle();
        if (gameError) throw new Error(kahootFriendlyError(gameError));
        if (!game) throw new Error('Игровая комната больше не существует.');
        kahootSession.game = game;
        const { data: players, error: playersError } = await supabaseClient.from('kahoot_players').select('id, game_id, player_name, score, streak, answered, joined_at').eq('game_id', game.id).order('joined_at', { ascending: true });
        if (playersError) throw new Error(kahootFriendlyError(playersError));
        kahootSession.players = players || [];

        if (oldQuestionIndex !== undefined && oldQuestionIndex !== game.question_index) {
            kahootSession.roundResult = null;
            kahootSession.myRoundAnswer = null;
            kahootSession.answerRows = [];
        }
        const roundIsRevealed = ['reveal', 'leaderboard', 'finished'].includes(game.status) && game.question_index >= 0;
        if (roundIsRevealed) {
            try {
                kahootSession.roundResult = await kahootRpc('kahoot_get_round_result', { p_pin: kahootSession.pin });
            } catch (_) { kahootSession.roundResult = null; }
            const { data: answerRows, error: answerError } = await supabaseClient.from('kahoot_answers')
                .select('player_id, answer_index, is_correct, points, response_ms')
                .eq('game_id', game.id).eq('question_index', game.question_index);
            if (!answerError) kahootSession.answerRows = answerRows || [];
            if (kahootSession.role === 'player') {
                kahootSession.myRoundAnswer = (kahootSession.answerRows || []).find(row => row.player_id === kahootSession.playerId) || null;
            }
        }
        kahootRenderCurrent();
    } catch (error) {
        showScreen('screen-kahoot');
        screenKahoot.innerHTML = `<div class="ql-shell"><div class="ql-error">${escapeHtml(kahootFriendlyError(error))}</div><button class="ql-secondary-button" onclick="window.kahootBackToMenu()">Вернуться в меню</button></div>`;
    } finally {
        kahootSyncInProgress = false;
        if (kahootSyncQueued) {
            kahootSyncQueued = false;
            window.kahootSync();
        }
    }
};

function kahootEscape(value) { return escapeHtml(value); }

function kahootColorClass(index) {
    return ['red', 'blue', 'yellow', 'green'][index] || 'blue';
}

function kahootChoicesHtml(question, opts = {}) {
    const correctIndex = Number.isInteger(opts.correctIndex) ? opts.correctIndex : -1;
    const chosenIndex = Number.isInteger(opts.chosenIndex) ? opts.chosenIndex : -1;
    const disabled = !!opts.disabled;
    const clickable = !!opts.clickable;
    return (question?.a || []).map((answer, index) => {
        let cls = `ql-answer ql-answer-${kahootColorClass(index)}`;
        if (opts.reveal && index === correctIndex) cls += ' ql-answer-correct';
        else if (opts.reveal && index === chosenIndex && chosenIndex !== correctIndex) cls += ' ql-answer-wrong';
        const onClick = clickable ? `onclick="window.kahootSubmitAnswer(${index})"` : '';
        const isDisabled = disabled ? 'disabled' : '';
        return `<button class="${cls}" ${onClick} ${isDisabled}><span class="ql-answer-shape">${['▲', '◆', '●', '■'][index] || '●'}</span><span>${kahootEscape(answer)}</span></button>`;
    }).join('');
}

function kahootRankingsHtml(players) {
    const sorted = [...(players || [])].sort((a, b) => (b.score || 0) - (a.score || 0) || new Date(a.joined_at) - new Date(b.joined_at));
    if (!sorted.length) return '<div class="ql-empty-state">Пока нет участников.</div>';
    return `<div class="ql-ranking-list">${sorted.map((player, index) => `
        <div class="ql-ranking-row ${index < 3 ? `rank-${index + 1}` : ''}">
            <div class="ql-rank-number">${index === 0 ? '👑' : index + 1}</div>
            <div class="ql-rank-name">${kahootEscape(player.player_name)}${player.id === kahootSession?.playerId ? ' <span class="ql-you">ВЫ</span>' : ''}</div>
            <div class="ql-rank-score">${Number(player.score || 0).toLocaleString()} <small>очков</small></div>
        </div>`).join('')}</div>`;
}

function kahootCommonHeader(subtitle = '') {
    return `<div class="ql-game-header"><div class="ql-brand"><span class="ql-brand-mark">Q</span><span>QUIZ LIVE</span></div><div class="ql-header-center">${kahootEscape(subtitle)}</div><button class="ql-nav-button" onclick="window.kahootBackToMenu()">Меню</button></div>`;
}

function kahootRenderCurrent() {
    if (!kahootSession?.game) return;
    showScreen('screen-kahoot');
    if (kahootSession.role === 'host') kahootRenderHost();
    else kahootRenderPlayer();
}

function kahootRenderHost() {
    const s = kahootSession;
    const g = s.game;
    const questionIndex = Number(g.question_index);
    const question = s.questions?.[questionIndex] || g.questions?.[questionIndex];
    const answeredCount = s.players.filter(player => player.answered).length;
    const timeLeft = kahootSecondsLeft(g);
    let body = '';

    if (g.status === 'lobby') {
        body = `
            <div class="ql-lobby-hero"><div class="ql-panel-kicker">КОМНАТА ОЖИДАНИЯ</div><h1>Подключайтесь к игре</h1><p>Участники вводят PIN на вашем сайте или открывают ссылку/QR-код.</p>
                <div class="ql-pin-label">PIN-КОД ИГРЫ</div><div class="ql-pin-number">${kahootEscape(s.pin)}</div>
                <div class="ql-host-share"><button class="ql-secondary-button" onclick="window.kahootCopyLink()">⧉ Скопировать ссылку</button><div id="ql-qr-code" class="ql-qr-box"></div></div>
            </div>
            <div class="ql-lobby-players"><div class="ql-section-title"><span>Участники</span><span class="ql-count-badge">${s.players.length}</span></div>
                ${s.players.length ? `<div class="ql-player-pills">${s.players.map((player, i) => `<span class="ql-player-pill"><span>${['✦','◆','●','▲'][i % 4]}</span>${kahootEscape(player.player_name)}</span>`).join('')}</div>` : '<div class="ql-empty-state">Пока никто не подключился. Покажите PIN группе.</div>'}
                <button class="ql-primary-button ql-start-button" ${s.players.length ? '' : 'disabled'} onclick="window.kahootHostAction('start', 0)">Начать игру →</button>
                <div class="ql-small-note">Вопросов: ${s.questions.length} · Время на ответ: ${g.duration_seconds} сек.</div>
            </div>`;
    } else if (g.status === 'question' && question) {
        const answeredPercent = s.players.length ? Math.round(answeredCount / s.players.length * 100) : 0;
        body = `
            <div class="ql-round-meta"><span>ВОПРОС ${questionIndex + 1} / ${s.questions.length}</span><span id="ql-time-left" class="ql-time-badge">${timeLeft}</span></div>
            <div class="ql-time-track"><div id="ql-time-bar" style="width:${Math.max(0, timeLeft / g.duration_seconds * 100)}%"></div></div>
            <div class="ql-host-question"><div class="ql-panel-kicker">ВОПРОС ДЛЯ ВСЕХ ИГРОКОВ</div><h1>${kahootEscape(question.q)}</h1></div>
            <div class="ql-answer-grid ql-host-answers">${kahootChoicesHtml(question)}</div>
            <div class="ql-response-status"><div><strong id="ql-answered-count">${answeredCount}</strong> из ${s.players.length} ответили</div><div class="ql-response-track"><span style="width:${answeredPercent}%"></span></div></div>
            <button class="ql-primary-button ql-reveal-button" onclick="window.kahootHostAction('reveal')">Показать результаты ↗</button>`;
    } else if ((g.status === 'reveal' || g.status === 'leaderboard') && question) {
        const correctIndex = s.questions?.[questionIndex]?.c ?? s.roundResult?.correct_index ?? -1;
        if (g.status === 'reveal') {
            body = `
                <div class="ql-round-meta"><span>РЕЗУЛЬТАТЫ ВОПРОСА ${questionIndex + 1}</span><span class="ql-state-pill">Ответы приняты</span></div>
                <div class="ql-host-question"><div class="ql-panel-kicker">ПРАВИЛЬНЫЙ ОТВЕТ ПОКАЗАН ЗЕЛЁНЫМ</div><h1>${kahootEscape(question.q)}</h1></div>
                <div class="ql-answer-grid">${kahootChoicesHtml(question, { reveal: true, correctIndex })}</div>
                <div class="ql-result-summary"><div><strong>${(s.answerRows || []).filter(row => row.is_correct).length}</strong><span>правильных ответов</span></div><div><strong>${(s.answerRows || []).length}</strong><span>ответили</span></div><div><strong>${s.players.length - (s.answerRows || []).length}</strong><span>без ответа</span></div></div>
                <button class="ql-primary-button" onclick="window.kahootHostAction('leaderboard')">Показать таблицу лидеров →</button>`;
        } else {
            body = `<div class="ql-leaderboard-heading"><div class="ql-panel-kicker">ПРОМЕЖУТОЧНЫЙ РЕЗУЛЬТАТ</div><h1>Таблица лидеров</h1><p>После каждого раунда очки пересчитываются по правильности и скорости ответа.</p></div>
                ${kahootRankingsHtml(s.players)}
                <button class="ql-primary-button" onclick="window.kahootHostNext()">${questionIndex + 1 >= s.questions.length ? 'Завершить игру' : 'Следующий вопрос →'}</button>`;
        }
    } else {
        body = `<div class="ql-leaderboard-heading"><div class="ql-panel-kicker">ИГРА ЗАВЕРШЕНА</div><h1>Финальная таблица</h1><p>Отличная игра! Итоговый результат участников.</p></div>
            ${kahootRankingsHtml(s.players)}
            <div class="ql-toolbar"><button class="ql-primary-button" onclick="window.kahootBackToMenu()">Вернуться в меню</button><button class="ql-secondary-button" onclick="window.kahootNewGame()">Создать ещё игру</button></div>`;
    }
    screenKahoot.innerHTML = `<div class="ql-shell ql-game-shell">${kahootCommonHeader(`${g.title} · Ведущий`)}${body}</div>`;
    if (g.status === 'lobby') kahootRenderQr();
}

function kahootRenderPlayer() {
    const s = kahootSession;
    const g = s.game;
    const index = Number(g.question_index);
    const question = g.questions?.[index];
    const me = s.players.find(player => player.id === s.playerId);
    const timeLeft = kahootSecondsLeft(g);
    let body = '';

    if (g.status === 'lobby') {
        body = `<div class="ql-player-wait"><div class="ql-wait-pulse">✓</div><div class="ql-panel-kicker">ВЫ ПОДКЛЮЧИЛИСЬ</div><h1>Привет, ${kahootEscape(s.name)}!</h1><p>Вы в игре <strong>${kahootEscape(g.title)}</strong>. Смотрите на экран ведущего — первый вопрос скоро появится.</p><div class="ql-pin-chip">PIN ${kahootEscape(s.pin)}</div><div class="ql-waiting-dots"><span></span><span></span><span></span></div><div class="ql-small-note">Участников в комнате: ${s.players.length}</div></div>`;
    } else if (g.status === 'question' && question) {
        const hasAnswered = !!me?.answered;
        body = `<div class="ql-round-meta"><span>ВОПРОС ${index + 1} / ${g.questions.length}</span><span id="ql-time-left" class="ql-time-badge">${timeLeft}</span></div>
            <div class="ql-time-track"><div id="ql-time-bar" style="width:${Math.max(0, timeLeft / g.duration_seconds * 100)}%"></div></div>
            <div class="ql-player-question"><h1>${kahootEscape(question.q)}</h1><div class="ql-small-note">Игрок: ${kahootEscape(s.name)}</div></div>
            ${hasAnswered ? `<div class="ql-answer-locked"><div class="ql-lock-check">✓</div><h2>Ответ зафиксирован!</h2><p>Отлично. Дождитесь окончания раунда, чтобы увидеть результат.</p><div class="ql-waiting-dots"><span></span><span></span><span></span></div></div>` : `<div class="ql-answer-grid ql-player-answers">${kahootChoicesHtml(question, { clickable: true, disabled: timeLeft <= 0 })}</div><div class="ql-small-note">Выберите один вариант. Чем быстрее правильный ответ, тем больше очков.</div>`}`;
    } else if ((g.status === 'reveal' || g.status === 'leaderboard') && question) {
        const correctIndex = s.roundResult?.correct_index ?? -1;
        const answer = s.myRoundAnswer;
        const correct = !!answer?.is_correct;
        body = `<div class="ql-player-result ${correct ? 'is-correct' : 'is-wrong'}"><div class="ql-result-symbol">${correct ? '✓' : '↻'}</div><div class="ql-panel-kicker">ВОПРОС ${index + 1} · РЕЗУЛЬТАТ</div><h1>${correct ? 'Правильно!' : 'В этот раз не получилось'}</h1><div class="ql-earned-points">+${Number(answer?.points || 0).toLocaleString()} <span>очков</span></div><p>${correct ? 'Отличная реакция! Следите за следующим вопросом.' : 'Запомните правильный вариант — впереди ещё вопросы.'}</p></div>
            <div class="ql-player-question"><h2>${kahootEscape(question.q)}</h2></div><div class="ql-answer-grid">${kahootChoicesHtml(question, { reveal: true, correctIndex, chosenIndex: answer ? answer.answer_index : -1 })}</div>
            ${g.status === 'leaderboard' ? `<div class="ql-player-rank-card"><div class="ql-panel-kicker">ТЕКУЩИЙ РЕЗУЛЬТАТ</div>${kahootRankingsHtml(s.players)}</div>` : `<div class="ql-waiting-banner">Ведущий скоро покажет таблицу лидеров…</div>`}`;
    } else {
        const sorted = [...s.players].sort((a, b) => b.score - a.score);
        const place = sorted.findIndex(player => player.id === s.playerId) + 1;
        body = `<div class="ql-player-result is-correct"><div class="ql-result-symbol">🏁</div><div class="ql-panel-kicker">ИГРА ЗАВЕРШЕНА</div><h1>Спасибо за игру, ${kahootEscape(s.name)}!</h1><div class="ql-earned-points">${Number(me?.score || 0).toLocaleString()} <span>очков</span></div><p>Ваш итоговый результат: ${place || '—'}-е место из ${s.players.length} участников.</p></div><div class="ql-player-rank-card"><h2>Финальная таблица лидеров</h2>${kahootRankingsHtml(s.players)}</div><button class="ql-primary-button" onclick="window.kahootBackToMenu()">Выйти в меню</button>`;
    }
    screenKahoot.innerHTML = `<div class="ql-shell ql-game-shell">${kahootCommonHeader(`${g.title} · ${s.name}`)}${body}</div>`;
}

function kahootSecondsLeft(game) {
    if (!game || game.status !== 'question' || !game.question_started_at) return Number(game?.duration_seconds || 20);
    const deadline = new Date(game.question_started_at).getTime() + Number(game.duration_seconds || 20) * 1000;
    return Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
}

function kahootClockTick() {
    if (!kahootSession?.game || kahootSession.game.status !== 'question') return;
    const game = kahootSession.game;
    const secondsLeft = kahootSecondsLeft(game);
    const timeText = document.getElementById('ql-time-left');
    const timeBar = document.getElementById('ql-time-bar');
    if (timeText) timeText.textContent = String(secondsLeft);
    if (timeBar) timeBar.style.width = `${Math.max(0, secondsLeft / Number(game.duration_seconds || 20) * 100)}%`;
    if (kahootSession.role === 'host' && secondsLeft <= 0 && !kahootActionInProgress) {
        window.kahootHostAction('reveal');
    }
    if (kahootSession.role === 'player' && secondsLeft <= 0) {
        document.querySelectorAll('.ql-player-answers .ql-answer').forEach(button => { button.disabled = true; });
    }
}

function kahootRenderQr() {
    const container = document.getElementById('ql-qr-code');
    if (!container) return;
    if (typeof QRCode === 'undefined') {
        container.innerHTML = '<span>Откройте ссылку на телефоне</span>';
        return;
    }
    container.innerHTML = '';
    try { new QRCode(container, { text: kahootUrl(kahootSession.pin), width: 150, height: 150, correctLevel: QRCode.CorrectLevel.M }); }
    catch (_) { container.textContent = `PIN ${kahootSession.pin}`; }
}

window.kahootCopyLink = async function() {
    if (!kahootSession?.pin) return;
    await kahootCopy(kahootUrl(kahootSession.pin));
};

window.kahootHostAction = async function(action, questionIndex = null) {
    if (!kahootSession || kahootSession.role !== 'host' || kahootActionInProgress) return;
    kahootActionInProgress = true;
    try {
        await kahootRpc('kahoot_host_action', {
            p_pin: kahootSession.pin,
            p_host_token: kahootSession.token,
            p_action: action,
            p_question_index: questionIndex
        });
        await window.kahootSync();
    } catch (error) {
        alert(kahootFriendlyError(error));
    } finally {
        kahootActionInProgress = false;
    }
};

window.kahootHostNext = async function() {
    if (!kahootSession?.game) return;
    await window.kahootHostAction('next', Number(kahootSession.game.question_index) + 1);
};

window.kahootSubmitAnswer = async function(answerIndex) {
    const s = kahootSession;
    if (!s || s.role !== 'player' || !s.game || s.game.status !== 'question') return;
    const me = s.players.find(player => player.id === s.playerId);
    if (me?.answered || kahootActionInProgress) return;
    kahootActionInProgress = true;
    document.querySelectorAll('.ql-player-answers .ql-answer').forEach(button => { button.disabled = true; });
    try {
        const result = await kahootRpc('kahoot_submit_answer', {
            p_pin: s.pin,
            p_player_id: s.playerId,
            p_player_token: s.token,
            p_question_index: Number(s.game.question_index),
            p_answer_index: Number(answerIndex)
        });
        s.myRoundAnswer = result;
        await window.kahootSync();
    } catch (error) {
        alert(kahootFriendlyError(error));
        await window.kahootSync();
    } finally {
        kahootActionInProgress = false;
    }
};

window.kahootNewGame = async function() {
    await kahootStopRealtime();
    kahootSession = null;
    localStorage.removeItem('kahoot_host_session');
    localStorage.removeItem('kahoot_player_session');
    await window.openKahootMenu();
};


// ==========================================
// ИНИЦИАЛИЗАЦИЯ ПРИЛОЖЕНИЯ
// ==========================================

async function init() {
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
                alert('Время сессии истекло.'); 
                renderLogin(); 
                return;
            }
            
            state.currentUser = parsed;
            if (sessionCheckInterval) clearInterval(sessionCheckInterval);
            sessionCheckInterval = setInterval(securityCheck, 15000);

            // A QR/link with a game PIN should open the public join menu even when this browser is logged in.
            if (/kahoot=\d{6}/i.test(window.location.hash)) {
                await window.openKahootMenu();
                return;
            }

            if (parsed.role === 'admin' || parsed.role === 'superadmin') { 
                try {
                    await openAdminPanel();
                } catch (e) {
                    // Временная ошибка сети/базы не должна выкидывать администратора из системы
                    console.error('Не удалось загрузить админ-панель:', e);
                }
            } else {
                const savedProgressStr = localStorage.getItem('test_progress');
                if (savedProgressStr) {
                    try {
                        const prog = JSON.parse(savedProgressStr);
                        await syncSubjects();
                        state.currentTestKey = prog.currentTestKey; 
                        state.currentPartName = prog.currentPartName || null;
                        state.questions = prog.questions; 
                        state.currentIndex = prog.currentIndex; 
                        state.score = prog.score;
                        state.wrongQuestions = prog.wrongQuestions; 
                        state.isRepeatMode = prog.isRepeatMode; 
                        state.qStates = prog.qStates || {};
                        
                        if (state.currentIndex >= state.questions.length) {
                            window.finishQuiz();
                        } else { 
                            renderQuizShell(); 
                            window.loadQuestion(); 
                        }
                        return;
                    } catch (e) { 
                        clearTestProgress(); 
                    }
                }
                window.renderSelection();
            }
            return;
        } catch (e) { 
            localStorage.removeItem('user'); 
        }
    }
    renderLogin();
    if (/kahoot=\d{6}/i.test(window.location.hash)) window.openKahootMenu();
}

// Доп. подстраховка: гарантированно сохраняем прогресс теста при закрытии
// вкладки, сворачивании приложения или обновлении страницы — на случай,
// если это происходит между обычными точками сохранения.
function persistProgressOnExit() {
    if (state.currentTestKey && state.questions.length) {
        saveTestProgress(false);
    }
}
window.addEventListener('beforeunload', persistProgressOnExit);
window.addEventListener('pagehide', persistProgressOnExit);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistProgressOnExit();
});

init();
