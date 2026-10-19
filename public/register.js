const form=document.querySelector('#registerForm'),result=document.querySelector('#authResult'),submit=form.querySelector('[type="submit"]');
const setRole=role=>{
  form.elements.role.value=role;
  document.querySelectorAll('.role-choice').forEach(button=>button.classList.toggle('selected',button.dataset.role===role));
  const requester=['requester','both'].includes(role),worker=['worker','both'].includes(role);
  document.querySelectorAll('.requester-field').forEach(field=>{field.classList.toggle('hidden',!requester);field.querySelector('input').required=requester});
  document.querySelectorAll('.worker-field').forEach(field=>{field.classList.toggle('hidden',!worker);const input=field.querySelector('input');input.required=worker&&input.name==='skills'});
  submit.textContent=role==='both'?'创建双角色账户':role==='requester'?'创建请求者账户':'创建工作者账户';
};
document.querySelectorAll('.role-choice').forEach(button=>button.addEventListener('click',()=>setRole(button.dataset.role)));
form.addEventListener('submit',async event=>{
  event.preventDefault();result.className='auth-result';const values=Object.fromEntries(new FormData(form));
  if(values.password!==values.confirmPassword){result.className='auth-result show error';result.textContent='两次输入的密码不一致。';return}
  delete values.confirmPassword;submit.disabled=true;submit.textContent='正在创建…';
  try{
    const response=await fetch('/api/opc/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(values)}),data=await response.json();
    if(!response.ok)throw new Error(data.error||`创建失败（${response.status}）`);
    result.className='auth-result show success';result.innerHTML=`账户创建成功。账户编号：<code>${data.account.id}</code><br><a href="/login.html?email=${encodeURIComponent(values.email)}">现在登录 →</a>`;form.reset();setRole('requester');
  }catch(error){result.className='auth-result show error';result.textContent=error.message}
  finally{submit.disabled=false;setRole(form.elements.role.value)}
});
