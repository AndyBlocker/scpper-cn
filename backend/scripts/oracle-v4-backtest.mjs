// Oracle v4 离线回测：增量驱动架构（只读、不写库、不改任何历史 tick）
// Δln(price) = K_FUND·scoreCorrected + stochIncr(OU 卷积纯函数) + anchorIncr(弱公允值锚)
// 链式连续 → 天然满足"下周开盘=本周收盘"。用真实 score_signal_raw 输入，自洽重放并对比 v3。
// 与 CategoryIndexTickJob.ts 的 V4 实现同算法。详见 docs/gacha-market-oracle-v4-backtest-2026-06-30.md
//
// 用法：
//   1) 导出 tick 历史 CSV（只读）：
//      psql "$DATABASE_URL" -c "\copy (SELECT category,as_of_ts,score_signal_raw,score_ref,\
//        score_provisional,index_mark,crowd_drag,noise FROM \"CategoryIndexTick\" ORDER BY 1,2) \
//        TO 'ticks.csv' WITH CSV HEADER"
//   2) 运行：GEN_FROM=2026-04-01 K_FUND=0.0013 SIGMA_TARGET=0.0055 ANCHOR_LAMBDA=0.25 \
//        node backend/scripts/oracle-v4-backtest.mjs ticks.csv
import fs from 'fs';
const CSV = process.argv[2] || './ticks.csv';
const HOUR=3600_000, DAY=86400_000, UTC8=8*HOUR, LN100=Math.log(100);
const GEN_START=Date.parse((process.env.GEN_FROM ?? '2026-06-08')+'T00:00:00+08:00');
const P={
  K_FUND: Number(process.env.K_FUND ?? 0.045),
  SCORE_CLAMP:3.6, BETA_SEAS_OVERALL:0.9, BETA_SEAS_OTHER:0.8, BETA_LEVEL:0.05,
  DRIFT_MIN_WEEKS:8, DRIFT_WINDOW_SAMPLES:26*168, EARLY_WEEK_HOURS:72,
  FAIR_GAMMA:0.18, ANCHOR_LAMBDA: Number(process.env.ANCHOR_LAMBDA ?? 0.02), SHOCK_SIGMA:0.0,
  SIGMA_TARGET: Number(process.env.SIGMA_TARGET ?? 0.006), VOL_WEEK_AMP:0.6,
  GARCH_ALPHA:0.18, GARCH_BETA:0.78,
  OU_KAPPA: Number(process.env.OU_KAPPA ?? 0.06),
  JUMP_LAMBDA: Number(process.env.JUMP_LAMBDA ?? 0.006), JUMP_MIN:0.03, JUMP_MAG: Number(process.env.JUMP_MAG ?? 0.05),
  STOCH_CLAMP:0.5, SALT:'backtest-v4',
};
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const std=a=>{if(a.length<2)return 0;const m=mean(a);return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1));};
function median(a){if(!a.length)return 0;const s=[...a].sort((x,y)=>x-y);const m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;}
function corr(x,y){const n=Math.min(x.length,y.length);if(n<3)return NaN;const mx=mean(x),my=mean(y);let a=0,b=0,c=0;for(let i=0;i<n;i++){const dx=x[i]-mx,dy=y[i]-my;a+=dx*dy;b+=dx*dx;c+=dy*dy;}return a/Math.sqrt(b*c||1);}
function acf(s,l){const n=s.length-l;if(n<3)return NaN;return corr(s.slice(0,n),s.slice(l));}
function hash32(s){let h=2166136261>>>0;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}
function mul32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function u(c,w,tag,t,k=0){return mul32(hash32(`${P.SALT}|${c}|${w}|${tag}|${t}|${k}`))();}
function nrm(c,w,tag,t){let s=0;for(let k=0;k<12;k++)s+=u(c,w,tag,t,k);return s-6;}
// 生产可落地的无状态随机层：OU 卷积纯函数（均值回复 + 有界方差 + 无运行状态）
// incr[绝对小时] 纯函数；S[t]=Σ (1-κ)^j·incr[t-j] = OU 闭式解；stochIncr=S[t]-S[t-1]
const incrCache=new Map();
function incrAt(cat,h){
  const key=cat+'|'+h; if(incrCache.has(key))return incrCache.get(key);
  const ts=h*HOUR, wk=weekStartMs(ts);
  const volWeek=1+P.VOL_WEEK_AMP*(u(cat,wk,'vol',0)-0.5)*2;     // 周级冷热 regime
  let incr=P.SIGMA_TARGET*volWeek*nrm(cat,wk,'ou',h);
  if(u(cat,wk,'jump',h)<P.JUMP_LAMBDA){const sgn=u(cat,wk,'js',h)<0.5?-1:1;incr+=sgn*(P.JUMP_MIN+P.JUMP_MAG*u(cat,wk,'jm',h));}
  incr=clamp(incr,-0.15,0.15); incrCache.set(key,incr); return incr;
}
const ouCache=new Map();
function ouLevel(cat,h){
  const key=cat+'|'+h; if(ouCache.has(key))return ouCache.get(key);
  let s=0,w=1; const decay=1-P.OU_KAPPA;
  for(let j=0;j<200;j++){ s+=w*incrAt(cat,h-j); w*=decay; if(w<1e-6)break; }
  ouCache.set(key,s); return s;
}
function weekStartMs(ts){const sh=ts+UTC8;const dow=new Date(sh).getUTCDay();const mo=(dow+6)%7;const ds=Math.floor(sh/DAY)*DAY;return ds-mo*DAY-UTC8;}
function offsetBucket(ts){return clamp(Math.floor((ts-weekStartMs(ts))/HOUR),0,167);}

const lines=fs.readFileSync(CSV,'utf8').trim().split('\n');lines.shift();
const byCat=new Map();
for(const ln of lines){const[cat,tsStr,raw,,prov,idx]=ln.split(',');const ts=Date.parse(tsStr.replace(' ','T')+'Z');if(!byCat.has(cat))byCat.set(cat,[]);byCat.get(cat).push({ts,raw:+raw,prov:+prov,v3:+idx});}
const CATS=['OVERALL','TRANSLATION','SCP','TALE','GOI','WANDERERS'];
const metrics={};

for(const cat of CATS){
  const rows=(byCat.get(cat)||[]).sort((a,b)=>a.ts-b.ts);
  const betaSeas=cat==='OVERALL'?P.BETA_SEAS_OVERALL:P.BETA_SEAS_OTHER;
  const rawAll=[]; const rawByBucket=new Map();
  let lastV4=null, firstGen=true, lastCloseRaw=0, ouS=0, ouSig2=P.SIGMA_TARGET**2, ouIncrPrev=0;
  const gen=[];
  for(const r of rows){
    const o=offsetBucket(r.ts), wk=weekStartMs(r.ts);
    const lvlPool=rawAll.length>P.DRIFT_WINDOW_SAMPLES?rawAll.slice(-P.DRIFT_WINDOW_SAMPLES):rawAll;
    const levelRef=lvlPool.length?median(lvlPool):0;
    const bkt=rawByBucket.get(o)||[];
    const seasonalRef=bkt.length>=P.DRIFT_MIN_WEEKS?(median(bkt)-levelRef):0;
    if(r.ts>=GEN_START){
      const wp=clamp(o/P.EARLY_WEEK_HOURS,0,1);
      const rawEff=wp*r.raw+(1-wp)*lastCloseRaw;
      const scoreCorrected=clamp(rawEff-betaSeas*seasonalRef-P.BETA_LEVEL*levelRef,-P.SCORE_CLAMP,P.SCORE_CLAMP);
      if(firstGen){lastV4=r.v3;firstGen=false;}
      // 无状态随机增量（OU 卷积纯函数：S[t]-S[t-1]）
      const absH=Math.floor(r.ts/HOUR);
      const stochIncr=ouLevel(cat,absH)-ouLevel(cat,absH-1);
      // 极弱公允值锚增量（防长期漂移；F 随基本面浮动）
      const F=LN100+P.FAIR_GAMMA*levelRef;
      const anchorIncr=P.ANCHOR_LAMBDA/168*(F-Math.log(lastV4));
      const sigComp=P.K_FUND*scoreCorrected;
      const dlog=sigComp+stochIncr+anchorIncr;
      const v4=lastV4*Math.exp(dlog);
      gen.push({ts:r.ts,o,ws:wk,raw:r.raw,scoreCorrected,sigComp,stochComp:stochIncr,anchComp:anchorIncr,v4,v3:r.v3});
      lastV4=v4;
    }
    rawAll.push(r.raw);const arr=rawByBucket.get(o)||[];arr.push(r.raw);rawByBucket.set(o,arr);
    if(o===167)lastCloseRaw=r.raw;
  }
  // 指标
  const lr4=[],lr3=[];for(let i=1;i<gen.length;i++){lr4.push(Math.log(gen[i].v4/gen[i-1].v4));lr3.push(Math.log(gen[i].v3/gen[i-1].v3));}
  const absL=lr4.map(Math.abs).sort((a,b)=>a-b),absL3=lr3.map(Math.abs).sort((a,b)=>a-b);
  const p=(a,q)=>a.length?a[Math.min(a.length-1,Math.floor(q*a.length))]:0;
  const sigC=[],anchC=[],stoC=[],lrIn=[];
  for(let i=0;i<gen.length;i++){sigC.push(gen[i].sigComp);anchC.push(gen[i].anchComp);stoC.push(gen[i].stochComp);lrIn.push(gen[i].sigComp+gen[i].stochComp+gen[i].anchComp);}
  const vTot=std(lrIn)**2||1;
  const pr4=[],pr3=[],rawm=[];
  for(let i=168;i<gen.length;i++){pr4.push(Math.log(gen[i].v4/gen[i-168].v4));pr3.push(Math.log(gen[i].v3/gen[i-168].v3));rawm.push(mean(gen.slice(i-168,i).map(g=>g.raw)));}
  const wkAmp=new Map();
  for(const g of gen){const e=wkAmp.get(g.ws)||{mn:1e9,mx:-1e9};e.mn=Math.min(e.mn,Math.log(g.v4));e.mx=Math.max(e.mx,Math.log(g.v4));wkAmp.set(g.ws,e);}
  const amps=[...wkAmp.values()].map(e=>e.mx-e.mn);
  // 净漂移（v4 全期总收益，看价格有没有跟基本面走出趋势）
  const totRet=gen.length>1?Math.log(gen[gen.length-1].v4/gen[0].v4):0;
  const mid=Math.floor(gen.length/2);
  const lateRet=gen.length>mid+1?Math.log(gen[gen.length-1].v4/gen[mid].v4):0; // 后半段净漂移：≈0=已稳态
  const finalIdx=gen.length?gen[gen.length-1].v4:0;
  const meanRaw=mean(gen.map(g=>g.raw));
  metrics[cat]={
    momAcf1_v4:acf(lr4,1),momAcf1_v3:acf(lr3,1),
    acf168_v4:acf(lr4,168),acf168_v3:acf(lr3,168),
    absMed_v4:p(absL,0.5)*100,absMed_v3:p(absL3,0.5)*100,absP95_v4:p(absL,0.95)*100,
    wkAmpMed_v4:median(amps)*100,
    corr7d_v4:corr(pr4,rawm),corr7d_v3:corr(pr3,rawm),
    varSig:std(sigC)**2/vTot*100,varAnch:std(anchC)**2/vTot*100,varStoch:std(stoC)**2/vTot*100,
    totRet:totRet*100,lateRet:lateRet*100,finalIdx,meanRaw,
  };
}
const f=(x,d=2)=>Number.isFinite(x)?x.toFixed(d):'NaN';
console.log('\n=== v4 增量驱动 K_FUND='+P.K_FUND+' σT='+P.SIGMA_TARGET+' jL='+P.JUMP_LAMBDA+' jMag='+P.JUMP_MAG+' λ='+P.ANCHOR_LAMBDA+' ===');
console.log('cat'.padEnd(11),'corr7d v4/v3 | wkAmp% | acf168 | totRet%/lateRet% | finalIdx | meanRaw');
for(const c of CATS){const m=metrics[c];
  console.log(c.padEnd(11),f(m.corr7d_v4)+'/'+f(m.corr7d_v3),'|',f(m.wkAmpMed_v4,1),'|',f(m.acf168_v4),'|',
    f(m.totRet,0)+'/'+f(m.lateRet,0),'|',f(m.finalIdx,1),'|',f(m.meanRaw));
}
const avg=k=>mean(CATS.map(c=>metrics[c][k]).filter(Number.isFinite));
console.log('\n--- 汇总 ---');
console.log('corr7d 价格vs基本面（目标>+0.5）: v4',f(avg('corr7d_v4'),3),' v3',f(avg('corr7d_v3'),3));
console.log('周振幅中位（中等档 8~15%）:',f(avg('wkAmpMed_v4'),1),'%');
console.log('小时|收益|中位: v4',f(avg('absMed_v4')),'% v3',f(avg('absMed_v3')),'%  p95 v4',f(avg('absP95_v4')),'%');
console.log('momentum acf1（趋势惯性,v4应>v3): v4',f(avg('momAcf1_v4'),3),' v3',f(avg('momAcf1_v3'),3));
console.log('acf168 周周期（目标<0.2）: v4',f(avg('acf168_v4'),3),' v3',f(avg('acf168_v3'),3));
console.log('logret方差占比 基本面/锚/随机:',f(avg('varSig'),0)+'% / '+f(avg('varAnch'),0)+'% / '+f(avg('varStoch'),0)+'%');
