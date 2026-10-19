const $=selector=>document.querySelector(selector);
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const statusLabel={draft:'草稿',recruiting:'招募中',team_confirming:'确认团队中',milestone_planning:'待确认验收计划',in_progress:'履约中',ready_to_close:'待请求者结项',completed:'已完成'};
async function load(){
  const response=await fetch('/api/opc/auth/session',{credentials:'same-origin'}),session=await response.json();
  if(!response.ok||session.account.role!=='admin'){location.href='/login.html';return}
  $('#adminIdentity').textContent=`管理员 · ${session.account.displayName}`;
  const result=await fetch('/api/opc/admin/overview',{credentials:'same-origin'}),data=await result.json();
  if(!result.ok)throw new Error(data.error||'读取平台概览失败');
  const cards=[['账户总数',data.counts.accounts],['请求者',data.counts.requesters],['工作者',data.counts.workers],['双角色账户',data.counts.bothRoles],['工单总数',data.counts.orders],['招募中',data.counts.recruiting],['履约中',data.counts.inProgress],['已完成',data.counts.completed]];
  $('#adminStats').innerHTML=cards.map(([label,value])=>`<article class="admin-stat"><small>${label}</small><strong>${value}</strong></article>`).join('');
  $('#adminOrders').innerHTML=data.recentOrders.length?data.recentOrders.map(order=>`<article class="admin-order"><div><small>${esc(order.code)}</small><h3>${esc(order.title)}</h3></div><span class="status ${esc(order.status)}">${statusLabel[order.status]||esc(order.status)}</span></article>`).join(''):'<div class="role-empty">还没有工单。</div>';
}
$('#logoutButton').onclick=async()=>{await fetch('/api/opc/auth/logout',{method:'POST',credentials:'same-origin'});location.href='/login.html'};
load().catch(error=>{$('#adminError').className='auth-result show error';$('#adminError').textContent=error.message});
