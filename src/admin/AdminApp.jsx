import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon.jsx';
import { ROOM_KK } from '../i18n.js';
import { normalize } from '../map-core.js';
import { getSession, authenticate, logout, getRooms, getRoomHistory, saveRoom } from './admin-client.js';
import './admin.css';

const TEXT = {
  ru: {
    title:'Управление картой', subtitle:'Кабинеты и названия', back:'Открыть карту', language:'Язык интерфейса', logout:'Выйти', loading:'Загружаем…', retry:'Повторить',
    login:'Вход для администратора', loginHint:'Войдите, чтобы менять подписи кабинетов на карте.', password:'Пароль', passwordAgain:'Повторите пароль', signIn:'Войти', signingIn:'Входим…',
    setup:'Создайте пароль администратора', setupHint:'Это первый вход. Придумайте пароль длиной от 12 до 128 символов и сохраните его у себя.', create:'Создать пароль и войти', noSetup:'Первую настройку нужно выполнить на компьютере сервера: откройте эту страницу через localhost.', mismatch:'Пароли не совпадают.', passwordLength:'Пароль должен содержать от 12 до 128 символов.',
    five:'А корпус', seven:'Б корпус', basement:'Подвал', floor:'этаж', buildings:'Корпус', floorChoice:'Этаж', search:'Поиск по номеру или названию', rooms:'Помещения', count:'Найдено', noRooms:'Помещений не найдено.', select:'Выберите помещение в списке слева.', planId:'ID на плане', unnumbered:'Без номера', number:'Номер кабинета', numberHint:'Например, 01А или 305. Оставьте пустым, если номера нет.', ru:'Название на русском', kk:'Название на казахском', kkHint:'Можно оставить пустым: карта использует перевод типового названия или русскую подпись.',
    editing:'Редактирование', save:'Сохранить изменения', saving:'Сохраняем…', cancel:'Отменить', saved:'Изменения сохранены. Новые подписи доступны на карте.', unsaved:'Есть несохранённые изменения', confirm:'Отменить несохранённые изменения?', required:'Укажите русское название. Номер — до 24 символов, названия — до 120. Символы < и > и управляющие символы недопустимы.', preview:'На карте', previewRu:'РУС', previewKk:'ҚАЗ', cabinet:'Кабинет', history:'Последние изменения', noHistory:'Для этого помещения пока нет изменений.', before:'Было', after:'Стало', historyError:'Не удалось загрузить историю.', reload:'Загрузить актуальные данные', conflictHint:'Ваша форма сохранена на экране. Загрузите актуальные данные и внесите изменения повторно.',
    UNAUTHORIZED:'Сессия завершилась. Войдите ещё раз.', INVALID_CREDENTIALS:'Неверный пароль.', FORBIDDEN:'Действие недоступно.', CSRF_INVALID:'Не удалось подтвердить сессию. Войдите повторно.', SETUP_LOCAL_ONLY:'Первую настройку можно выполнить только на компьютере сервера.', ALREADY_CONFIGURED:'Пароль уже создан. Войдите с существующим паролем.', VALIDATION_ERROR:'Проверьте номер и названия кабинета.', DUPLICATE_NUMBER:'Такой номер уже есть на этом этаже корпуса. Укажите другой номер.', REVISION_CONFLICT:'Данные уже изменены в другой вкладке.', RATE_LIMITED:'Слишком много попыток. Немного подождите и повторите.', NOT_FOUND:'Помещение не найдено. Обновите список.', NETWORK_ERROR:'Не удалось связаться с сервером. Проверьте подключение и повторите.', SERVER_ERROR:'Сервис временно недоступен. Повторите попытку.', INVALID_RESPONSE:'Сервер вернул некорректный ответ. Повторите попытку.'
  },
  kk: {
    title:'Картаны басқару', subtitle:'Кабинеттер мен атаулар', back:'Картаны ашу', language:'Интерфейс тілі', logout:'Шығу', loading:'Жүктелуде…', retry:'Қайталау',
    login:'Әкімші кіруі', loginHint:'Картадағы кабинет жазуларын өзгерту үшін кіріңіз.', password:'Құпиясөз', passwordAgain:'Құпиясөзді қайталаңыз', signIn:'Кіру', signingIn:'Кіру орындалуда…',
    setup:'Әкімші құпиясөзін жасаңыз', setupHint:'Бұл — алғашқы кіру. 12–128 таңбадан тұратын құпиясөз ойлап тауып, өзіңізде сақтаңыз.', create:'Құпиясөз жасап, кіру', noSetup:'Алғашқы баптауды сервер компьютерінде орындаңыз: осы бетті localhost арқылы ашыңыз.', mismatch:'Құпиясөздер сәйкес келмейді.', passwordLength:'Құпиясөз 12–128 таңбадан тұруы керек.',
    five:'А корпусы', seven:'Б корпусы', basement:'Жертөле', floor:'қабат', buildings:'Корпус', floorChoice:'Қабат', search:'Нөмірі немесе атауы бойынша іздеу', rooms:'Бөлмелер', count:'Табылды', noRooms:'Бөлмелер табылмады.', select:'Сол жақтағы тізімнен бөлмені таңдаңыз.', planId:'Жоспардағы ID', unnumbered:'Нөмірі жоқ', number:'Кабинет нөмірі', numberHint:'Мысалы, 01А немесе 305. Нөмірі болмаса, бос қалдырыңыз.', ru:'Орысша атауы', kk:'Қазақша атауы', kkHint:'Бос қалдыруға болады: карта үлгі атауының аудармасын немесе орысша жазуды қолданады.',
    editing:'Өңдеу', save:'Өзгерістерді сақтау', saving:'Сақталуда…', cancel:'Болдырмау', saved:'Өзгерістер сақталды. Жаңа жазулар картада қолжетімді.', unsaved:'Сақталмаған өзгерістер бар', confirm:'Сақталмаған өзгерістерден бас тартасыз ба?', required:'Орысша атауын көрсетіңіз. Нөмірі — 24, атаулары — 120 таңбаға дейін. < және > және басқарушы таңбаларды қолдануға болмайды.', preview:'Картадағы көрінісі', previewRu:'РУС', previewKk:'ҚАЗ', cabinet:'Кабинет', history:'Соңғы өзгерістер', noHistory:'Бұл бөлме үшін әзірге өзгерістер жоқ.', before:'Бұрын', after:'Қазір', historyError:'Өзгерістер тарихын жүктеу мүмкін болмады.', reload:'Өзекті деректерді жүктеу', conflictHint:'Енгізілген мәтін экранда сақталды. Өзекті деректерді жүктеп, өзгерістерді қайта енгізіңіз.',
    UNAUTHORIZED:'Сессия аяқталды. Қайта кіріңіз.', INVALID_CREDENTIALS:'Құпиясөз қате.', FORBIDDEN:'Әрекет қолжетімсіз.', CSRF_INVALID:'Сессияны растау мүмкін болмады. Қайта кіріңіз.', SETUP_LOCAL_ONLY:'Алғашқы баптау тек сервер компьютерінде орындалады.', ALREADY_CONFIGURED:'Құпиясөз жасалған. Қолданыстағы құпиясөзбен кіріңіз.', VALIDATION_ERROR:'Кабинет нөмірі мен атауларын тексеріңіз.', DUPLICATE_NUMBER:'Осы корпус қабатында мұндай нөмір бар. Басқа нөмірді көрсетіңіз.', REVISION_CONFLICT:'Деректер басқа қойындыда өзгертілген.', RATE_LIMITED:'Тым көп әрекет жасалды. Біраз күтіп, қайталаңыз.', NOT_FOUND:'Бөлме табылмады. Тізімді жаңартыңыз.', NETWORK_ERROR:'Серверге қосылу мүмкін болмады. Байланысты тексеріп, қайталаңыз.', SERVER_ERROR:'Сервис уақытша қолжетімсіз. Қайталап көріңіз.', INVALID_RESPONSE:'Сервер дұрыс емес жауап қайтарды. Қайталап көріңіз.'
  }
};
const emptyDraft = () => ({number:'',labelRu:'',labelKk:''});
const draftOf = room => ({number:room?.number??'',labelRu:room?.labelRu??room?.label??'',labelKk:room?.labelKk??''});
const pointKey = room => room && `${room.building}:${room.floor}:${room.id}`;
const storage = {get(key){try{return localStorage.getItem(key);}catch{return null;}},set(key,value){try{localStorage.setItem(key,value);}catch{}}};
const safeLanguage = () => new URLSearchParams(location.search).get('lang')==='kk'||(!new URLSearchParams(location.search).has('lang')&&storage.get('hdu-language')==='kk')?'kk':'ru';

export default function AdminApp() {
  const [language,setLanguage]=useState(safeLanguage);
  const translate=key=>TEXT[language][key]||TEXT[language].SERVER_ERROR;
  const params=useMemo(()=>new URLSearchParams(location.search),[]);
  const [building,setBuilding]=useState(()=>params.get('building')==='seven'?'seven':'five');
  const [floor,setFloor]=useState(()=>{const n=Number(params.get('floor')??1);return Number.isInteger(n)&&n>=0&&n<=(params.get('building')==='seven'?7:5)&&!(params.get('building')==='seven'&&n===0)?n:1;});
  const [session,setSession]=useState(null),[sessionError,setSessionError]=useState(''),[sessionAttempt,setSessionAttempt]=useState(0);
  const [password,setPassword]=useState(''),[confirmation,setConfirmation]=useState(''),[authBusy,setAuthBusy]=useState(false);
  const [rooms,setRooms]=useState([]),[revision,setRevision]=useState(''),[roomsBusy,setRoomsBusy]=useState(false),[roomsError,setRoomsError]=useState(''),[reload,setReload]=useState(0),[query,setQuery]=useState('');
  const [selected,setSelected]=useState(null),[draft,setDraft]=useState(emptyDraft),[saving,setSaving]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  const [history,setHistory]=useState([]),[historyBusy,setHistoryBusy]=useState(false),[historyError,setHistoryError]=useState(false),[historyAttempt,setHistoryAttempt]=useState(0);
  const active=useRef(true),operation=useRef(null),suspendedDraft=useRef(null);
  const dirty=!!selected&&JSON.stringify(draft)!==JSON.stringify(draftOf(selected));
  const dirtyRef=useRef(dirty);dirtyRef.current=dirty||!!suspendedDraft.current?.dirty;
  const editorRef=useRef(null);editorRef.current={dirty,selected,draft,revision,building,floor};
  const floorLabel=n=>n===0?translate('basement'):`${n} ${translate('floor')}`;
  const mapHref=`/?${new URLSearchParams({building,floor:String(floor),lang:language})}`;
  const selectedKey=pointKey(selected);
  const previewKk=draft.labelKk||ROOM_KK[draft.labelRu]||draft.labelRu;
  const errorText=code=>TEXT[language][code]||translate('SERVER_ERROR');
  const discardAllowed=()=>!dirtyRef.current||window.confirm(translate('confirm'));
  const guardMapNavigation=event=>{
    if(saving||!discardAllowed()){event.preventDefault();return;}
    // The user accepted discarding before navigating; avoid a second unload prompt.
    suspendedDraft.current=null;dirtyRef.current=false;
  };

  useEffect(()=>{active.current=true;return()=>{active.current=false;operation.current?.abort();};},[]);
  useEffect(()=>{
    const previousLight=document.body.classList.contains('light');
    document.body.classList.add('admin-page','light');
    document.body.classList.remove('planner-open','has-selection');
    return()=>{document.body.classList.remove('admin-page');if(!previousLight)document.body.classList.remove('light');};
  },[]);
  useEffect(()=>{
    document.documentElement.lang=language;document.title=`${translate('title')} — ХДУ`;
    storage.set('hdu-language',language);
    const url=new URLSearchParams(location.search);url.set('lang',language);historyAPIReplace(`/admin?${url}`);
  },[language]);
  useEffect(()=>{
    const onBeforeUnload=event=>{if(dirtyRef.current){event.preventDefault();event.returnValue='';}};
    window.addEventListener('beforeunload',onBeforeUnload);return()=>window.removeEventListener('beforeunload',onBeforeUnload);
  },[]);
  useEffect(()=>{
    const controller=new AbortController();setSessionError('');
    getSession({signal:controller.signal}).then(({data})=>{if(!controller.signal.aborted)setSession(data);}).catch(err=>{if(!controller.signal.aborted)setSessionError(err.code||'NETWORK_ERROR');});
    return()=>controller.abort();
  },[sessionAttempt]);

  const expireSession=(err,preserve=true)=>{
    if(err.status===401||err.code==='CSRF_INVALID'){
      if(preserve&&editorRef.current.dirty)suspendedDraft.current={...editorRef.current};
      setSession(current=>({...current,authenticated:false,configured:true}));setRooms([]);setSelected(null);setDraft(emptyDraft());setHistory([]);setRevision('');setSessionError(err.code==='CSRF_INVALID'?'CSRF_INVALID':'UNAUTHORIZED');return true;
    }return false;
  };
  useEffect(()=>{
    if(!session?.authenticated)return;
    const controller=new AbortController();setRoomsBusy(true);setRoomsError('');
    getRooms(building,floor,{signal:controller.signal}).then(({data,revision:nextRevision})=>{
      if(controller.signal.aborted)return;
      if(!Array.isArray(data))throw {code:'INVALID_RESPONSE'};
      setRooms(data);setHistory([]);
      const suspended=suspendedDraft.current;
      if(suspended&&suspended.building===building&&suspended.floor===floor&&data.some(room=>pointKey(room)===pointKey(suspended.selected))){
        setRevision(suspended.revision);setSelected(suspended.selected);setDraft(suspended.draft);suspendedDraft.current=null;
      }else{setRevision(nextRevision);setSelected(null);setDraft(emptyDraft());}
    }).catch(err=>{if(!controller.signal.aborted&&!expireSession(err))setRoomsError(err.code||'NETWORK_ERROR');}).finally(()=>{if(!controller.signal.aborted)setRoomsBusy(false);});
    return()=>controller.abort();
  },[session?.authenticated,building,floor,reload]);
  useEffect(()=>{
    setHistory([]);setHistoryError(false);
    if(!selectedKey||!session?.authenticated){setHistoryBusy(false);return;}
    const controller=new AbortController();setHistoryBusy(true);
    getRoomHistory(selected,{signal:controller.signal}).then(({data})=>{
      if(!controller.signal.aborted){if(!Array.isArray(data))throw {code:'INVALID_RESPONSE'};setHistory(data);}
    }).catch(err=>{if(!controller.signal.aborted&&!expireSession(err))setHistoryError(true);}).finally(()=>{if(!controller.signal.aborted)setHistoryBusy(false);});
    return()=>controller.abort();
  },[selectedKey,session?.authenticated,historyAttempt]);

  async function submitAuth(event){
    event.preventDefault();if(authBusy)return;
    const setup=!session.configured;
    if(setup&&([...password].length<12||[...password].length>128||/[\u0000-\u001f\u007f]/u.test(password))){setSessionError('passwordLength');return;}
    if(setup&&password!==confirmation){setSessionError('mismatch');return;}
    const controller=new AbortController();operation.current=controller;setAuthBusy(true);setSessionError('');
    try{const {data}=await authenticate(password,setup,{signal:controller.signal});if(active.current&&!controller.signal.aborted){setPassword('');setConfirmation('');setSession(data);}}
    catch(err){if(active.current&&!controller.signal.aborted){setSessionError(err.code==='VALIDATION_ERROR'?'passwordLength':err.code||'NETWORK_ERROR');if(err.code==='ALREADY_CONFIGURED')setSession(current=>({...current,configured:true}));}}
    finally{if(active.current&&!controller.signal.aborted)setAuthBusy(false);}
  }
  function chooseRoom(room){if(saving||!discardAllowed())return;setSelected(room);setDraft(draftOf(room));setMessage('');setError('');}
  function changeContext(nextBuilding,nextFloor){if(saving||!discardAllowed())return;setSelected(null);setDraft(emptyDraft());setRooms([]);setBuilding(nextBuilding);setFloor(nextFloor);setQuery('');setMessage('');setError('');}
  async function submitEdit(event){
    event.preventDefault();if(!selected||saving||!dirty)return;
    const cleaned={number:draft.number.trim(),labelRu:draft.labelRu.trim(),labelKk:draft.labelKk.trim()};
    if(!cleaned.labelRu||cleaned.number.length>24||cleaned.labelRu.length>120||cleaned.labelKk.length>120||Object.values(cleaned).some(value=>/[<>\u0000-\u001f\u007f]/u.test(value))){setError('required');return;}
    const controller=new AbortController();operation.current=controller;setSaving(true);setError('');setMessage('');
    try{
      const {data,revision:nextRevision}=await saveRoom(selected,cleaned,revision,session.csrfToken,{signal:controller.signal});
      if(!active.current||controller.signal.aborted)return;
      if(!data||pointKey(data)!==selectedKey)throw {code:'INVALID_RESPONSE'};
      setRooms(current=>current.map(room=>pointKey(room)===pointKey(data)?data:room));setSelected(data);setDraft(draftOf(data));setRevision(nextRevision);setMessage('saved');setHistoryAttempt(value=>value+1);
      storage.set('hdu-map-revision',nextRevision);
      window.dispatchEvent(new window.CustomEvent('hdu-map-updated',{detail:{revision:nextRevision}}));
    }catch(err){if(active.current&&!controller.signal.aborted&&!expireSession(err))setError(err.code||'NETWORK_ERROR');}
    finally{if(active.current&&!controller.signal.aborted)setSaving(false);}
  }
  async function signOut(){
    if(authBusy||saving||!discardAllowed())return;
    const controller=new AbortController();operation.current=controller;setAuthBusy(true);setError('');suspendedDraft.current=null;
    try{await logout(session.csrfToken,{signal:controller.signal});if(active.current){setSession(current=>({...current,authenticated:false}));setRooms([]);setSelected(null);setDraft(emptyDraft());setHistory([]);setRevision('');setMessage('');setPassword('');setConfirmation('');}}
    catch(err){if(active.current&&!controller.signal.aborted&&!expireSession(err,false))setError(err.code||'NETWORK_ERROR');}
    finally{if(active.current&&!controller.signal.aborted)setAuthBusy(false);}
  }
  const visibleRooms=rooms.filter(room=>{
    const needle=normalize(query);
    return !needle||normalize(`${room.number??''} ${room.labelRu??room.label} ${room.labelKk??''} ${room.id}`).includes(needle);
  });
  const renderChanges=record=><><span>{record.number||translate('unnumbered')}</span><b>{record.labelRu}</b>{record.labelKk&&<small lang="kk">{record.labelKk}</small>}</>;

  return <div className="admin-app">
    <header className="admin-header"><a className="admin-brand" href={mapHref} onClick={guardMapNavigation}><img src="/assets/hdu-logo.png" alt="ХДУ" width="48" height="48"/><span><b>ХДУ<span>.</span></b><small>{translate('title')}</small></span></a><div className="admin-header-actions"><a className="admin-map-link" href={mapHref} onClick={guardMapNavigation}><Icon type="arrow"/>{translate('back')}</a><div className="language-switch" role="group" aria-label={translate('language')}>{[['kk','ҚАЗ'],['ru','РУС']].map(([lang,label])=><button type="button" key={lang} lang={lang} aria-pressed={language===lang} className={language===lang?'active':''} onClick={()=>setLanguage(lang)}>{label}</button>)}</div>{session?.authenticated&&<button id="adminLogout" type="button" disabled={saving||authBusy} onClick={signOut}>{translate('logout')}</button>}</div></header>
    {!session?<main className="admin-auth"><section className="admin-auth-card"><img src="/assets/hdu-logo.png" width="64" height="64" alt="ХДУ"/><h1>{translate('title')}</h1><p role={sessionError?'alert':'status'}>{sessionError?errorText(sessionError):translate('loading')}</p>{sessionError&&<button type="button" id="adminSessionRetry" className="primary" onClick={()=>setSessionAttempt(value=>value+1)}>{translate('retry')}</button>}</section></main>:!session.authenticated?<main className="admin-auth"><section className="admin-auth-card"><span className="admin-kicker">ХДУ · {translate('subtitle')}</span><h1>{translate(session.configured?'login':'setup')}</h1><p>{translate(session.configured?'loginHint':session.canSetup?'setupHint':'noSetup')}</p>{(session.configured||session.canSetup)&&<form id="adminAuthForm" onSubmit={submitAuth}><label htmlFor="adminPassword">{translate('password')}</label><input id="adminPassword" type="password" autoComplete={session.configured?'current-password':'new-password'} minLength={session.configured?undefined:12} maxLength={128} required value={password} onChange={event=>setPassword(event.target.value)} disabled={authBusy}/>{!session.configured&&<><label htmlFor="adminPasswordConfirm">{translate('passwordAgain')}</label><input id="adminPasswordConfirm" type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={confirmation} onChange={event=>setConfirmation(event.target.value)} disabled={authBusy}/></>}<button id="adminSignIn" type="submit" className="primary" disabled={authBusy} aria-busy={authBusy}>{translate(authBusy?'signingIn':session.configured?'signIn':'create')}<Icon type="arrow"/></button></form>}{sessionError&&<p className="admin-error" role="alert">{errorText(sessionError)}</p>}</section></main>:<main className="admin-workspace">
      <section className="admin-page-heading"><div><p className="admin-kicker">ХДУ · {translate('title')}</p><h1>{translate('subtitle')}</h1></div><span className="admin-count">{rooms.length} {translate('rooms').toLowerCase()}</span></section>
      <section className="admin-filters" aria-label={translate('rooms')}><div className="admin-corpora" role="group" aria-label={translate('buildings')}>{['five','seven'].map(value=><button key={value} type="button" aria-pressed={building===value} className={building===value?'active':''} disabled={saving} onClick={()=>{if(value!==building)changeContext(value,1);}}><Icon type={value}/>{translate(value)}</button>)}</div><label className="admin-floor-select">{translate('floorChoice')}<select id="adminFloor" value={floor} disabled={saving} onChange={event=>changeContext(building,Number(event.target.value))}>{Array.from({length:building==='five'?6:7},(_,index)=>building==='five'?index:index+1).map(value=><option key={value} value={value}>{floorLabel(value)}</option>)}</select></label><label className="admin-search-label"><Icon type="search"/><input id="adminRoomSearch" type="search" maxLength={120} aria-label={translate('search')} placeholder={translate('search')} value={query} onChange={event=>setQuery(event.target.value)}/></label></section>
      {message&&<p id="adminSuccess" className="admin-success" role="status">{translate(message)}</p>}
      <div className="admin-columns"><section className="admin-room-list-panel"><div className="admin-section-heading"><h2>{translate('rooms')}</h2><span>{translate('count')}: {visibleRooms.length}</span></div>{roomsBusy?<p className="admin-empty" role="status">{translate('loading')}</p>:roomsError?<div className="admin-empty"><p className="admin-error" role="alert">{errorText(roomsError)}</p><button type="button" onClick={()=>setReload(value=>value+1)}>{translate('retry')}</button></div>:<div className="admin-room-list" role="group" aria-label={translate('rooms')}>{visibleRooms.map(room=><button key={pointKey(room)} type="button" className={`admin-room-row${pointKey(room)===selectedKey?' active':''}`} aria-pressed={pointKey(room)===selectedKey} disabled={saving} data-admin-room={room.id} onClick={()=>chooseRoom(room)}><span className="admin-room-icon"><Icon type={room.type==='stair'?'stair':room.type==='wc'?'wc':'room'}/></span><span className="admin-room-copy"><b>{room.number?`${translate('cabinet')} ${room.number}`:room.labelRu||room.label}</b><small>{room.labelRu||room.label}</small>{room.labelKk&&<small lang="kk">{room.labelKk}</small>}</span><span className="admin-plan-id">ID {room.id}</span></button>)}{!visibleRooms.length&&<p className="admin-empty">{translate('noRooms')}</p>}</div>}</section>
        <section className="admin-editor" aria-label={translate('editing')}>{!selected?<div className="admin-editor-placeholder"><Icon type="room"/><p>{translate('select')}</p></div>:<><div className="admin-editor-heading"><div><p className="admin-kicker">{translate(building)} · {floorLabel(floor)}</p><h2>{translate('editing')}</h2></div><span className="admin-id-badge">{translate('planId')}: {selected.id}</span></div><form id="adminEditForm" onSubmit={submitEdit} aria-busy={saving}><label htmlFor="adminRoomNumber">{translate('number')}</label><input id="adminRoomNumber" aria-describedby="adminNumberHint" type="text" autoComplete="off" maxLength={24} value={draft.number} onChange={event=>{setDraft(current=>({...current,number:event.target.value}));setMessage('');}} disabled={saving}/><small id="adminNumberHint">{translate('numberHint')}</small><label htmlFor="adminLabelRu">{translate('ru')} <span aria-hidden="true">*</span></label><input id="adminLabelRu" lang="ru" type="text" maxLength={120} required value={draft.labelRu} onChange={event=>{setDraft(current=>({...current,labelRu:event.target.value}));setMessage('');}} disabled={saving}/><label htmlFor="adminLabelKk">{translate('kk')}</label><input id="adminLabelKk" lang="kk" type="text" maxLength={120} value={draft.labelKk} onChange={event=>{setDraft(current=>({...current,labelKk:event.target.value}));setMessage('');}} disabled={saving}/><small>{translate('kkHint')}</small><div className="admin-label-preview"><span>{translate('preview')}</span><div><small>{translate('previewRu')}</small><b>{draft.number?`${translate('cabinet')} ${draft.number}`:draft.labelRu||'—'}</b><p lang="ru">{draft.labelRu||'—'}</p></div><div><small>{translate('previewKk')}</small><b>{draft.number?`${draft.number}-кабинет`:previewKk||'—'}</b><p lang="kk">{previewKk||'—'}</p></div></div><div className="admin-form-actions"><button id="adminSave" className="primary" type="submit" disabled={saving||!dirty}>{translate(saving?'saving':'save')}<Icon type="arrow"/></button><button id="adminCancel" type="button" disabled={saving||!dirty} onClick={()=>{if(discardAllowed()){setDraft(draftOf(selected));setError('');}}}>{translate('cancel')}</button></div>{dirty&&<p className="admin-dirty" role="status">{translate('unsaved')}</p>}{error&&<div className="admin-error" role="alert"><p>{errorText(error)}</p>{error==='REVISION_CONFLICT'&&<><p>{translate('conflictHint')}</p><button id="adminReloadConflict" type="button" onClick={()=>{if(discardAllowed()){setSelected(null);setDraft(emptyDraft());setError('');setReload(value=>value+1);}}}>{translate('reload')}</button></>}</div>}</form><section className="admin-history"><h3>{translate('history')}</h3>{historyBusy?<p role="status">{translate('loading')}</p>:historyError?<div><p>{translate('historyError')}</p><button type="button" onClick={()=>setHistoryAttempt(value=>value+1)}>{translate('retry')}</button></div>:history.length?<ol>{history.map(item=><li key={item.id}><time dateTime={item.createdAt}>{formatDate(item.createdAt,language)}</time><div className="admin-history-diff"><div><small>{translate('before')}</small>{renderChanges(item.before)}</div><Icon type="arrow"/><div><small>{translate('after')}</small>{renderChanges(item.after)}</div></div></li>)}</ol>:<p>{translate('noHistory')}</p>}</section></>}</section>
      </div>{error&&!selected&&<p className="admin-error" role="alert">{errorText(error)}</p>}
    </main>}
  </div>;
}

function historyAPIReplace(url){try{window.history.replaceState(null,'',url);}catch{}}
function formatDate(value,language){const date=new Date(value);return Number.isNaN(date.valueOf())?'—':new Intl.DateTimeFormat(language==='kk'?'kk-KZ':'ru-RU',{dateStyle:'medium',timeStyle:'short'}).format(date);}
