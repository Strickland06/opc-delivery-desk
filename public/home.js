const $=selector=>document.querySelector(selector);
const homeAuth=$('#homeAuthLinks'),sessionPanel=$('#sessionPanel'),roleForm=$('#roleForm'),roleAction=$('#roleAction');
let account=null;
function hasRole(role){return account?.role==='both'||account?.role===role}
function roleTitle(role){return role==='both'?'请求者 + 工作者':role==='requester'?'请求者':'工作者'}
function openRoleForm(){
  const missing=account.role==='requester'?'worker':'requester';
  $('#roleFields').innerHTML=missing==='worker'
    ?'<label>技能方向<input name="skills" maxlength="500" required placeholder="例如：前端开发、数据分析、AI 应用"></label>'
    :'<label>企业或团队名称<input name="organizationName" maxlength="120" required placeholder="填写企业或团队名称"></label>';
  $('#roleSubmit').textContent=missing==='worker'?'保存并开启工作者身份':'保存并开启请求者身份';
  roleForm.hidden=false;
}
function updateHome(){
  homeAuth.hidden=true;sessionPanel.hidden=false;
  $('#identityMessage').textContent=`你好，${account.displayName}`;
  $('#identityRoles').textContent=`当前账户：${roleTitle(account.role)} · 两个工作台共用这次登录`;
  if(account.role==='admin'){$('#adminEntry').hidden=false;$('#requesterCard').classList.add('identity-locked');$('#workerCard').classList.add('identity-locked');return}
  roleAction.hidden=account.role==='both';
  if(account.role!=='both')roleAction.textContent=`开启${account.role==='requester'?'工作者':'请求者'}身份`;
  for(const [id,role] of [['requesterCard','requester'],['workerCard','worker']]){
    const card=$(`#${id}`),enabled=hasRole(role);card.classList.toggle('identity-locked',!enabled);
    card.querySelector('.portal-link span').textContent=enabled?'在独立窗口打开':'点击开通此身份';
  }
}
async function load(){
  const response=await fetch('/api/opc/auth/session',{credentials:'same-origin'});
  if(!response.ok)return;
  const data=await response.json();account=data.account;updateHome();
}
roleAction.onclick=()=>{roleForm.hidden?openRoleForm():roleForm.hidden=true};
for(const [id,role] of [['requesterCard','requester'],['workerCard','worker']])$(`#${id}`).addEventListener('click',event=>{
  if(account&&!hasRole(role)){event.preventDefault();openRoleForm();roleForm.scrollIntoView({behavior:'smooth',block:'center'})}
});
roleForm.onsubmit=async event=>{
  event.preventDefault();const button=$('#roleSubmit'),result=$('#roleResult');button.disabled=true;result.textContent='正在保存…';
  try{
    const response=await fetch('/api/opc/auth/enable-role',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(roleForm)))}),data=await response.json();
    if(!response.ok)throw new Error(data.error||'身份开通失败');
    account=data.account;roleForm.hidden=true;updateHome();
  }catch(error){result.textContent=error.message}
  finally{button.disabled=false}
};
$('#logoutButton').onclick=async()=>{await fetch('/api/opc/auth/logout',{method:'POST',credentials:'same-origin'});location.reload()};
load();
