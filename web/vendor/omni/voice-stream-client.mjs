import {SSEParser} from './voice-core.mjs';

// Resume the SAME bounded input session, never create/replay an answered turn.
export class VoiceStreamClient {
  constructor({base='/voice/api/stream/sessions',headers={'X-Voice-Demo':'1'},onEvent=()=>{},onError=()=>{},
    onConnection=()=>{},reconnectMaxMs=45000,requestTimeoutMs=4000,retryDelayMs=500,heartbeatTimeoutMs=6000}={}) {
    Object.assign(this,{base,headers,onEvent,onError,onConnection,requestTimeoutMs,retryDelayMs,heartbeatTimeoutMs});
    this.reconnectMaxMs=Math.min(45000,Math.max(0,reconnectMaxMs));
    this.pending=0;this.pendingBytes=0;this.sequence=0;this.lastEvent=0;
    this.uploads=Promise.resolve();this.abort=new AbortController();this.closed=false;
    this.recovering=new Set();this.clientId=crypto.randomUUID().replaceAll('-','');
  }
  stage(path) {return path.endsWith('/audio')?'audio':path.endsWith('/commit')?'commit':path.includes('/events')?'events':'start';}
  recover(stage) {
    if(!this.recoveryDeadline)this.recoveryDeadline=performance.now()+this.reconnectMaxMs;
    const remaining=this.recoveryDeadline-performance.now();
    if(remaining<=0){const e=Error('Reconnection timed out. No question or spoken reply was replayed.');e.voiceTransport=true;throw e;}
    this.recovering.add(stage);
    this.onConnection({state:'reconnecting',stage,remaining_ms:Math.ceil(remaining)});
    return remaining;
  }
  connected(stage) {
    const had=this.recovering.size;this.recovering.delete(stage);
    if(had&&!this.recovering.size){this.recoveryDeadline=0;this.onConnection({state:'connected'});}
  }
  async delay(ms) {
    if(this.abort.signal.aborted)throw new DOMException('Stopped','AbortError');
    await new Promise((resolve,reject)=>{
      const stop=()=>{clearTimeout(timer);reject(new DOMException('Stopped','AbortError'));};
      const timer=setTimeout(()=>{this.abort.signal.removeEventListener('abort',stop);resolve();},ms);
      this.abort.signal.addEventListener('abort',stop,{once:true});
    });
  }
  async request(path,method,body,{json=false,retry=false}={}) {
    const stage=this.stage(path);
    while(!this.closed){
      if(this.recoveryDeadline&&performance.now()>=this.recoveryDeadline)this.recover(stage);
      const abort=new AbortController(),stop=()=>abort.abort();
      this.abort.signal.addEventListener('abort',stop,{once:true});
      const remaining=this.recoveryDeadline?Math.max(1,this.recoveryDeadline-performance.now()):this.requestTimeoutMs;
      const timer=setTimeout(()=>abort.abort(),Math.min(this.requestTimeoutMs,remaining));
      try {
        const response=await fetch(path,{method,headers:{...this.headers,'Content-Type':'application/json'},
          body:body===undefined?undefined:JSON.stringify(body),signal:abort.signal});
        if(!response.ok){
          const e=Error(`Voice stream HTTP ${response.status}`);e.status=response.status;
          if(response.status===429&&stage==='audio'&&this.asrOnly){
            const detail=await response.json().catch(()=>null);
            e.asrBacklog=detail?.detail?.code==='asr_backlog';
            const seconds=Number(response.headers.get('Retry-After'));
            e.retryAfterMs=seconds>0?Math.min(5000,seconds*1000):1000;
          }
          throw e;
        }
        const value=json?await response.json():response;
        if(!json)this.eventAbort=abort;
        this.connected(stage);return value;
      } catch(e) {
        if(this.closed||this.abort.signal.aborted)throw new DOMException('Stopped','AbortError');
        const transient=(e.name==='TypeError'||e.name==='AbortError'||e.voiceTransport||e.status===503
          ||e.asrBacklog||(stage==='events'&&e.status===409));
        if(!retry||!transient){if(transient)e.voiceTransport=true;throw e;}
        const budget=this.recover(stage);await this.delay(Math.min(e.asrBacklog?e.retryAfterMs:this.retryDelayMs,budget));
      } finally {
        clearTimeout(timer);this.abort.signal.removeEventListener('abort',stop);
      }
    }
    throw new DOMException('Stopped','AbortError');
  }
  async start(options={}) {
    if(this.id)throw Error('Session already started');
    const s=await this.request(this.base,'POST',{model:'omni-voice',...options,client_session_id:this.clientId},{json:true,retry:true});
    this.id=s.session_id;
    if(!/^[a-f0-9]{32}$/.test(this.id)||s.protocol!=='omni-voice-stream-v1')throw Error('Unexpected voice session');
    this.url=this.base+'/'+this.id;
    this.resumeEnabled=s.reconnect?.event_ids===true&&s.reconnect?.idempotent_audio===true&&s.reconnect?.idempotent_commit===true;
    if(s.reconnect&&(!this.resumeEnabled||!Number.isInteger(s.reconnect.max_ms)||s.reconnect.max_ms<1||s.reconnect.max_ms>45000))
      throw Error('Unexpected voice reconnection contract');
    if(this.resumeEnabled)this.reconnectMaxMs=Math.min(this.reconnectMaxMs,s.reconnect.max_ms);
    this.asrOnly=options.asr_only===true;
    if(this.asrOnly&&(s.asr_only!==true||s.input_mode!=='asr-only'||s.continuous!==(options.continuous===true)
      ||s.max_audio_seconds!==(options.continuous===true?600:30))){
      await this.stop();throw Error('Server did not confirm ASR-only mode; no audio was uploaded');
    }
    this.descriptor=s;
    const response=await this.request(this.url+'/events','GET',undefined,{retry:this.resumeEnabled});
    this.reading=this.readEvents(response).catch(e=>{if(!this.closed){e.voiceTransport=!e.voiceProtocol;this.onError(e);}});
    return s;
  }
  async readEvents(response) {
    let complete=false;
    while(!this.closed&&!complete){
      const reader=response.body.getReader(),decoder=new TextDecoder();let lastByte=performance.now();
      const parser=new SSEParser((event,data,id)=>{
        if(this.resumeEnabled){
          const n=Number(id);
          if(!/^\d+$/.test(id||'')||!Number.isSafeInteger(n)||n<1||n>this.lastEvent+1){
            const e=Error('Invalid resumable voice event');e.voiceProtocol=true;throw e;
          }
          if(n<=this.lastEvent)return; // Lost socket tail may overlap its reconnect.
          this.onEvent(event,data);this.lastEvent=n;
        }else this.onEvent(event,data);
        if(['done','error','retry'].includes(event))complete=true;
      });
      const idle=this.resumeEnabled?setInterval(()=>{if(performance.now()-lastByte>this.heartbeatTimeoutMs)this.eventAbort?.abort();},Math.min(1000,this.heartbeatTimeoutMs/2)):null;
      const stop=()=>this.eventAbort?.abort();this.abort.signal.addEventListener('abort',stop,{once:true});
      try {
        while(!this.closed&&!complete){const {done,value}=await reader.read();if(done)break;
          lastByte=performance.now();parser.feed(decoder.decode(value,{stream:true}));}
        if(!complete&&!this.closed){const e=Error('Voice stream ended without done');e.voiceTransport=true;throw e;}
      }catch(e){
        if(this.closed||complete)return;
        if(!this.resumeEnabled||e.voiceProtocol||e.name==='SyntaxError')throw e;
        this.recover('events');
      }finally{
        clearInterval(idle);this.abort.signal.removeEventListener('abort',stop);
        await reader.cancel().catch(()=>{});reader.releaseLock();
      }
      if(complete||this.closed)return;
      await this.delay(Math.min(this.retryDelayMs,this.recover('events')));
      response=await this.request(this.url+'/events?after='+this.lastEvent,'GET',undefined,{retry:true});
    }
  }
  append(audio) {
    if(!this.id||this.closed||this.committed)throw Error('No accepting voice session');
    const bytes=atob(audio).length;
    if(!bytes||bytes%2||bytes>32000)throw Error('Expected at most one second of PCM16 LE audio');
    // Long dictation does not retain the full recording: only unacknowledged
    // PCM may queue, bounded to 30 seconds regardless of chunk size.
    if(this.pending>=120||this.pendingBytes+bytes>960000)throw Error('Maximum buffered recording reached');
    this.pending++;this.pendingBytes+=bytes;
    const sequence=this.sequence++;
    this.uploads=this.uploads.then(async()=>{
      const ack=await this.request(this.url+'/audio','POST',{sequence,audio},{json:true,retry:this.resumeEnabled});
      if(ack.next_sequence!==sequence+1)throw Error('Voice audio sequence mismatch');
    }).finally(()=>{this.pending--;this.pendingBytes-=bytes;});
    return this.uploads;
  }
  async commit() {
    if(this.committed)return;this.committed=true;
    await this.uploads;
    await this.request(this.url+'/commit','POST',{}, {json:true,retry:this.resumeEnabled});
  }
  async stop(reason='client_stop') {
    if(this.closed)return;this.closed=true;this.abort.abort();this.eventAbort?.abort();
    this.recovering.clear();this.onConnection({state:'stopped'});
    if(this.url)await fetch(this.url,{method:'DELETE',headers:{...this.headers,'Content-Type':'application/json'},
      body:JSON.stringify({reason}),signal:AbortSignal.timeout(3000)}).catch(()=>{});
  }
}
