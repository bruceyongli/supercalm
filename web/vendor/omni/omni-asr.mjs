import {VoiceStreamClient} from './voice-stream-client.mjs';

// Pure recognition, not a conversation client. Owns rolling uploads, same-
// session recovery and replaceable drafts; never synthesizes or plays speech.
export class OmniASR {
  constructor({base='/voice/api/stream/sessions',headers={'X-Voice-Demo':'1'},
    appId='omni-asr',language='auto',continuous=true,onTranscript=()=>{},
    onConnection=()=>{},onError=()=>{},clientOptions={}}={}) {
    Object.assign(this,{appId,language,continuous,onTranscript,onError});
    this.segments=[];this.draft='';this.tail=new Uint8Array();this.inputBytes=0;
    this.done=new Promise((resolve,reject)=>{this.resolve=resolve;this.reject=reject;});
    this.done.catch(()=>{}); // Caller may inspect partials before awaiting finish.
    this.client=new VoiceStreamClient({...clientOptions,base,headers,onConnection,
      onEvent:(event,data)=>this.event(event,data),onError:e=>this.fail(e)});
  }
  get confirmedText(){return this.segments.filter(Boolean).join('\n\n');}
  get text(){return [this.confirmedText,this.draft].filter(Boolean).join('\n\n');}
  notify(final=false){this.onTranscript({text:this.text,confirmedText:this.confirmedText,
    draft:this.draft,segments:this.segments.length,final});}
  protocolError(message){const e=Error(message);e.voiceProtocol=true;throw e;}
  event(event,data) {
    if(['text','audio','sentence_speech','llm_route','retry'].includes(event))
      this.protocolError('ASR-only received a conversation event');
    if(event==='error'){this.fail(Error(data.message||'Recognition stopped'));return;}
    if(['session_ready','transcript_partial','transcript_final','done'].includes(event)&&data.asr_only!==true)
      this.protocolError('ASR-only event did not confirm recognition mode');
    if(event==='transcript_partial'||event==='transcript_final'){
      if(!Number.isInteger(data.segment_id)||data.segment_id<0||typeof data.text!=='string')
        this.protocolError('Invalid ASR segment');
      if(data.segment_id<this.segments.length){
        if(event==='transcript_final'&&this.segments[data.segment_id]===data.text)return;
        this.protocolError('ASR revised an already confirmed segment');
      }
      if(data.segment_id!==this.segments.length)this.protocolError('ASR segment gap');
      if(event==='transcript_partial')this.draft=data.text;
      else{this.segments.push(data.text);this.draft='';}
      this.notify();
    }
    if(event==='done'){
      if(data.llm_calls!==0||data.tts_calls!==0||data.audio_frames!==0||data.text!==this.confirmedText)
        this.protocolError('Unexpected ASR-only completion');
      this.settled=true;this.finished=true;this.draft='';this.notify(true);this.resolve({...data,text:this.text});
      void this.endCapture(false);void this.client.stop();
    }
  }
  fail(error) {
    if(this.settled)return;this.settled=true;this.failed=true;this.reject(error);
    void this.endCapture(false);void this.client.stop();this.onError(error);
  }
  async start() {
    if(this.started)throw Error('Recognition already started');this.started=true;
    try{
      this.session=await this.client.start({asr_only:true,continuous:this.continuous,
        language:this.language,app_id:this.appId});
      return this.session;
    }catch(e){this.fail(e);throw e;}
  }
  accepting() {
    if(!this.session||this.finished||this.failed||this.finishing||this.settled)throw Error('No accepting recognition session');
  }
  pushPCM(pcm) {
    this.accepting();
    if(!(pcm instanceof Uint8Array)||pcm.length%2||pcm.length>32000)throw Error('Expected at most one second of PCM16 LE bytes');
    if(this.inputBytes+pcm.length>this.session.max_audio_seconds*32000)throw Error('Recognition audio limit reached');
    const merged=new Uint8Array(this.tail.length+pcm.length);merged.set(this.tail);merged.set(pcm,this.tail.length);
    // Preflight the whole push, so overflow cannot accept only half a packet.
    if(this.client.pendingBytes+merged.length>960000||this.client.pending+Math.ceil(merged.length/8000)>120)
      throw Error('Maximum buffered recording reached; finish or stop recognition');
    this.inputBytes+=pcm.length;
    let offset=0;while(offset+8000<=merged.length){this.upload(merged.subarray(offset,offset+8000));offset+=8000;}
    this.tail=merged.slice(offset);
  }
  upload(pcm) {
    let raw='';for(const byte of pcm)raw+=String.fromCharCode(byte);
    this.client.append(btoa(raw)).catch(e=>this.fail(e));
  }
  pushFloat(samples,sampleRate=16000) {
    this.accepting();
    if(!(samples instanceof Float32Array)||samples.some(x=>!Number.isFinite(x))||!Number.isFinite(sampleRate)||sampleRate<8000||sampleRate>96000)
      throw Error('Expected bounded Float32 microphone samples');
    if(samples.length>sampleRate)throw Error('Push at most one second of microphone audio');
    if(this.sourceRate&&this.sourceRate!==sampleRate)throw Error('Microphone sample rate changed');
    this.sourceRate=sampleRate;
    // Stateful linear resampling: packet boundaries do not drop/repeat samples.
    const previous=this.sourceTail??new Float32Array(),merged=new Float32Array(previous.length+samples.length);
    merged.set(previous);merged.set(samples,previous.length);
    const values=[];let pos=this.sourcePosition||0;const step=sampleRate/16000;
    while(pos+1<merged.length){const i=Math.floor(pos),fraction=pos-i;
      values.push(merged[i]*(1-fraction)+merged[i+1]*fraction);pos+=step;}
    const used=Math.min(Math.floor(pos),merged.length);
    this.sourceTail=merged.slice(used);this.sourcePosition=pos-used;
    const pcm=new Uint8Array(values.length*2),view=new DataView(pcm.buffer);
    values.forEach((v,i)=>{v=Math.max(-1,Math.min(1,v));view.setInt16(i*2,v<0?v*32768:v*32767,true);});
    this.pushPCM(pcm);
  }
  async listen({workletUrl=new URL('./capture-worklet.js',import.meta.url).href}={}) {
    if(this.context||this.listening)throw Error('Microphone is already active');this.listening=true;
    try{
      // Permission and worklet loading must not spend the server's five-second
      // first-upload deadline or hold its single slot while a dialog is open.
      this.media=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true},video:false});
      if(this.settled){this.media.getTracks().forEach(t=>t.stop());throw Error('Recognition stopped');}
      this.context=new AudioContext();await this.context.audioWorklet.addModule(workletUrl);await this.context.resume();
      this.source=this.context.createMediaStreamSource(this.media);
      this.worklet=new AudioWorkletNode(this.context,'voice-capture');
      if(!this.session)await this.start();this.accepting();
      this.worklet.port.onmessage=({data})=>{
        if(data?.type==='flushed'){this.flushed?.();return;}
        if(this.settled)return;
        try{this.pushFloat(data,this.context.sampleRate);}catch(e){this.fail(e);}
      };
      this.mute=this.context.createGain();this.mute.gain.value=0;
      this.source.connect(this.worklet).connect(this.mute).connect(this.context.destination);
    }catch(e){this.fail(e);throw e;}finally{this.listening=false;}
    return this;
  }
  async endCapture(flush) {
    this.source?.disconnect();
    if(flush&&this.worklet){
      await new Promise(resolve=>{
        const timer=setTimeout(resolve,500);
        this.flushed=()=>{clearTimeout(timer);resolve();};this.worklet.port.postMessage({type:'flush'});
      });
      this.flushed=null;
    }
    this.media?.getTracks().forEach(t=>t.stop());this.worklet?.disconnect();this.mute?.disconnect();
    const context=this.context;this.context=null;this.worklet=null;this.source=null;this.media=null;
    if(context)await context.close().catch(()=>{});
  }
  async finish() {
    if(this.finishing||this.finished||this.failed||this.settled)return this.done;
    await this.endCapture(true);this.accepting();
    // Include the final interpolation tail (at most a few source samples).
    if(this.sourceTail?.length){
      const sample=Math.max(-1,Math.min(1,this.sourceTail.at(-1)));
      const count=Math.ceil((this.sourceTail.length-(this.sourcePosition||0))/(this.sourceRate/16000));
      const pcm=new Uint8Array(Math.max(0,count)*2),view=new DataView(pcm.buffer);
      for(let i=0;i<count;i++)view.setInt16(i*2,sample<0?sample*32768:sample*32767,true);
      this.pushPCM(pcm);this.sourceTail=null;
    }
    this.finishing=true;
    try{if(this.tail.length){this.upload(this.tail);this.tail=new Uint8Array();}await this.client.commit();}
    catch(e){this.fail(e);}
    return this.done;
  }
  async stop(reason='user_stop') {
    if(!this.settled){this.settled=true;this.reject(new DOMException('Recognition stopped; confirmed text retained','AbortError'));}
    this.tail=new Uint8Array();this.sourceTail=null;await this.endCapture(false);await this.client.stop(reason);
  }
}
