/**
 * Flappy Bird Pluggable Game Module
 * Implements the GameModule interface. Swap by replacing this file + updating game-config.json.
 * Rules: synced maps (same seed = same pipes), deterministic physics, dead birds become obstacles.
 */

var c; // canvas context, set in render()

const GRAVITY=0.55,JUMP_FORCE=-9.5,TERMINAL_FALL=14,DEAD_GRAVITY=0.35,DEAD_TERMINAL=6;
const BIRD_R=12,BIRD_X=120;
const PIPE_W=80,PIPE_GAP=180,PIPE_SPACING=220,PIPE_SPEED=3;
const W=800,H=600,GROUND=100,CEILING=0;
const GAP_MIN=80,GAP_MAX=H-GROUND-80;
const TICK=16.67,MAX_TICKS=3600;
function lcgNext(s){return((s*1103515245+12345)&0x7fffffff)>>>0;}
function lcgRand(s){return lcgNext(s)/0x7fffffff;}
function lcgInt(s,mi,ma){return Math.floor(mi+lcgRand(s)*(ma-mi));}
export const metadata={id:"flappy-bird",name:"Flappy Bird",description:"Multiplayer Flappy Bird last bird flying wins. Dead birds become obstacles.",maxPlayers:10,minPlayers:2};
export function createGameState(seed,players){
 const pipes=[];let prng=seed>>>0;
 for(let i=0;i<8;i++){
 const g=lcgInt(prng,GAP_MIN,GAP_MAX);
 pipes.push({x:W+i*PIPE_SPACING,gapY:g,id:i,scored:false});
 prng=lcgNext(prng);
 }
 const birds={};
 for(const p of players)birds[p.id]={x:BIRD_X,y:H/2-GROUND/2,vy:0,alive:1,deadTime:-1,score:0,color:p.color||"#e8b400"};
 return{seed:seed>>>0,tick:0,timestamp:0,running:1,winner:null,data:{seed:seed>>>0,prngState:seed>>>0,birds,pipes,width:W,height:H,gravity:GRAVITY,jumpForce:JUMP_FORCE,groundHeight:GROUND,pipeSpeed:PIPE_SPEED,gameOver:0,winner:null,aliveCount:players.length,totalPlayers:players.length}};
}
function circleRect(cx,cy,r,rx,ry,rw,rh){const cx1=Math.max(rx,Math.min(cx,rx+rw)),cy1=Math.max(ry,Math.min(cy,ry+rh));const dx=cx-cx1,dy=cy-cy1;return dx*dx+dy*dy<=r*r;}
function circleCircle(x1,y1,r1,x2,y2,r2){const dx=x1-x2,dy=y1-y2;return dx*dx+dy*dy<=(r1+r2)*(r1+r2);}
function pipeHit(b,pipes){for(const p of pipes){const t={x:p.x,y:0,w:PIPE_W,h:p.gapY-PIPE_GAP/2},b2={x:p.x,y:p.gapY+PIPE_GAP/2,w:PIPE_W,h:H-GROUND-(p.gapY+PIPE_GAP/2)};if(circleRect(b.x,b.y,BIRD_R,t.x,t.y,t.w,t.h)||circleRect(b.x,b.y,BIRD_R,b2.x,b2.y,b2.w,b2.h))return 1;}return 0;}
function groundHit(b){const gY=H-GROUND;return b.y+BIRD_R>gY||b.y-BIRD_R<CEILING;}
function deadHit(b,bs){for(const[id,o]of Object.entries(bs))if(!o.alive){const gY=H-GROUND;if(circleCircle(b.x,b.y,BIRD_R,o.x,o.y,BIRD_R+2))return 1;}return 0;}
export function updateGameState(s,i,dt){
 const d=s.data;d.tick=s.tick+1;d.timestamp=s.timestamp+dt;
 const l=d.pipes[d.pipes.length-1];
 if(l&&l.x<W-PIPE_SPACING+PIPE_SPEED){const g=lcgInt(d.prngState,GAP_MIN,GAP_MAX);d.pipes.push({x:W,gapY:g,id:d.pipes.length,scored:0});d.prngState=lcgNext(d.prngState);}
 for(const p of d.pipes){p.x-=d.pipeSpeed;if(!p.scored&&p.x+PIPE_W<BIRD_X)p.scored=1;}
 if(d.pipes.length>4&&d.pipes[0].x+PIPE_W<0)d.pipes.shift();
 for(const[id,b]of Object.entries(d.birds)){
 if(b.alive){
 const inpt=i[id];if(inpt&&inpt.jump)b.vy=d.jumpForce;
 b.vy+=d.gravity;if(b.vy>14)b.vy=14;b.y+=b.vy;
 if(pipeHit(b,d.pipes)||groundHit(b)||deadHit(b,d.birds)){b.alive=0;b.deadTime=d.timestamp;d.aliveCount=Math.max(0,d.aliveCount-1);}
 }else{b.vy+=0.35;if(b.vy>6)b.vy=6;b.y+=b.vy;const gY=H-GROUND-12;if(b.y>gY){b.y=gY;b.vy=0;}}
 }
 if(d.aliveCount<=1&&!d.gameOver){d.gameOver=1;const a=Object.entries(d.birds).filter(([,b])=>b.alive);if(a.length===1)d.winner=a[0][0];}
 if(d.tick>=MAX_TICKS){d.gameOver=1;if(!d.winner){const a=Object.entries(d.birds).filter(([,b])=>b.alive);if(a.length===1)d.winner=a[0][0];}}
 s.winner=d.winner;s.running=!d.gameOver;s.data=d;s.tick=d.tick;s.timestamp=d.timestamp;return s;
}
let prevJump=0;
export function getLocalInput(k){
 const j=k.has(" ")||k.has("ArrowUp")||k.has("w")||k.has("W")||k.has("ArrowSpace");
 const jp=j&&!prevJump;prevJump=j;return{jump:j,t:Date.now()};
}
export function render(ctx,s,lP,w,h){
 c=ctx;
 const d=s.data;const sc=Math.min(w/800,h/600);const sw=800*sc,sh=600*sc;const ox=(w-sw)/2,oy=(h-sh)/2;
 c.save();c.scale(sc,sc);c.translate(ox/sc,oy/sc);
 c.fillStyle="#0a0a15";c.fillRect(0,0,800,600);
 const g=c.createLinearGradient(0,0,0,500);g.addColorStop(0,"#0a0a1a");g.addColorStop(0.5,"#0f1020");g.addColorStop(1,"#0a0a15");c.fillStyle=g;c.fillRect(0,0,800,500);
 c.fillStyle="#fff";c.globalAlpha=0.3;for(let i=0;i<50;i++){const sx=lcgRand(s.data.seed*1000+i*3)*800,sy=lcgRand(s.data.seed*1000+i*3+1)*450,sz=lcgRand(s.data.seed*1000+i*3+2)*2;if(sz>.5)c.fillRect(sx,sy,Math.max(1,sz),Math.max(1,sz));}c.globalAlpha=1;
 for(const p of s.data.pipes){drawPipe(p.x,0,PIPE_W,p.gapY-PIPE_GAP/2,1);drawPipe(p.x,p.gapY+PIPE_GAP/2,PIPE_W,500-(p.gapY+PIPE_GAP/2),0);}
 c.fillStyle="#3a1c07";c.fillRect(0,500,800,100);c.fillStyle="#4a250a";for(let i=0;i<800;i+=40){c.fillRect(i,500,20,50);c.fillRect(i+20,550,20,50);}
 for(const[id,b]of Object.entries(s.data.birds))drawBird(b,id,s.data.seed);
 drawUI(s.data);
 c.restore();
}
function drawPipe(x,y,w,h,t){c.fillStyle="#22c55e";c.strokeStyle="#16a34a";c.lineWidth=2;c.beginPath();c.roundRect(x,y,w,h,[8,8,0,0]);c.fill();c.stroke();c.fillStyle="#16a34a";if(t){c.beginPath();c.moveTo(x-5,y+h);c.lineTo(x+w+5,y+h);c.lineTo(x+w+5,y+h+20);c.lineTo(x-5,y+h+20);c.fill();}else{c.beginPath();c.moveTo(x-5,y);c.lineTo(x+w+5,y);c.lineTo(x+w+5,y-20);c.lineTo(x-5,y-20);c.fill();}}
function drawBird(b,id,seed){
 if(b.alive){c.fillStyle=b.color||"#e8b400";c.strokeStyle="#d97706";c.lineWidth=1.5;c.beginPath();c.arc(b.x,b.y,12,0,2*Math.PI);c.fill();c.stroke();c.fillStyle="#000";const o=b.vy<0?3:0;c.beginPath();c.arc(b.x-4+o,b.y-3,2.5,0,2*Math.PI);c.fill();}else{c.fillStyle="#6b7280";c.strokeStyle="#4b5563";c.lineWidth=1.5;c.beginPath();c.arc(b.x,b.y,12,0,2*Math.PI);c.fill();c.stroke();}
 c.font="bold 12px monospace";c.fillStyle=b.alive?"#10b981":"#ef4444";c.textAlign="center";c.fillText(id.slice(0,6),b.x,b.y-18);
 if(id===b.id&&b.alive){c.strokeStyle="#e8b400";c.lineWidth=3;c.beginPath();c.arc(b.x,b.y,16,0,2*Math.PI);c.stroke();}
}
function drawUI(d){c.font="bold 18px monospace";c.fillStyle=d.aliveCount>1?"#10b981":"#ef4444";c.textAlign="center";c.fillText(d.aliveCount+"/"+d.totalPlayers+" ALIVE",400,30);if(!d.running&&d.winner){c.fillStyle="rgba(0,0,0,.7)";c.fillRect(0,250,800,80);c.fillStyle="#e8b400";c.font="bold 32px monospace";c.fillText("WINNER: "+d.winner.slice(0,8),400,295);}}
export function getPlayerStatus(s,id){const b=s.data.birds[id];return b&&b.alive?"alive":"dead";}
export function isMatchOver(s){return!s.running;}
export function getWinner(s){return s.data.winner||null;}
export function compileReplay(i,s,d,w,wn,p){return{gameModule:"flappy-bird",seed:s,duration:d,winner:w,winnerName:wn,players:p,inputs:i,createdAt:Date.now(),replayId:"rpl_"+Date.now().toString(36)+"_"+Math.random().toString(36).slice(2,8)};}
export function loadReplay(r){
 let s=createGameState(r.seed,r.players||[]);const t={};
 for(const[id,pi]of Object.entries(r.inputs))for(const inp of pi){const tk=Math.floor(inp.t/16.67);if(!t[tk])t[tk]={};t[tk][id]={jump:inp.jump,t:inp.t};}
 const a=[s];let tk=0;
 while(tk<3600){tk++;const i=t[tk]||{};if(!s.running)break;s=updateGameState(s,i,16.67);a.push(s);if(!s.running)break;}
 return a;
}
export function generateReplayId(){return"rpl_"+Date.now().toString(36)+"_"+Math.random().toString(36).slice(2,8);}
export default{metadata,createGameState,updateGameState,getLocalInput,render,getPlayerStatus,isMatchOver,getWinner,compileReplay,loadReplay,generateReplayId};