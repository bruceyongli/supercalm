// Shared browser output package. No credentials, model tuning or tool execution.
// Applications supply an unlocked AudioContext and their SAME-ORIGIN backend URLs.
import {fromBase64, playbackStart, SSEParser, SUPPORTED_VOICES} from './voice-core.mjs';

export const SPEECH_PROTOCOL = 'omni-speech-v1';
const MODEL = 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice';

// Native packets are independent PCM WAVs, sometimes only a few samples long.
// Parsing PCM directly avoids browser compressed-audio decoder variability.
export function decodeSpeechPCM(encoded, context) {
  if (typeof encoded !== 'string' || encoded.length > 5_400_000) throw Error('Invalid speech frame size');
  const bytes = fromBase64(encoded), view = new DataView(bytes);
  const tag = at => String.fromCharCode(...new Uint8Array(bytes, at, 4));
  if (bytes.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || view.getUint32(4,true)+8 !== bytes.byteLength)
    throw Error('Invalid speech WAV');
  let format = false, pcm = null, at=12;
  for (; at+8 <= bytes.byteLength;) {
    const name=tag(at), size=view.getUint32(at+4,true), start=at+8;
    if (start+size > bytes.byteLength) throw Error('Truncated speech WAV');
    if (name==='fmt ') {
      if (format || size < 16 || view.getUint16(start,true)!==1 || view.getUint16(start+2,true)!==1
          || view.getUint32(start+4,true)!==24000 || view.getUint32(start+8,true)!==48000
          || view.getUint16(start+12,true)!==2 || view.getUint16(start+14,true)!==16) throw Error('Expected mono 24kHz PCM16');
      format=true;
    } else if (name==='data') {
      if (pcm || !size || size%2) throw Error('Invalid PCM data');
      pcm={start,size};
    }
    at=start+size+(size%2);
  }
  if (!format || !pcm || at!==bytes.byteLength) throw Error('Missing or malformed PCM data/format');
  const buffer=context.createBuffer(1,pcm.size/2,24000), channel=buffer.getChannelData(0);
  for (let i=0;i<channel.length;i++) channel[i]=view.getInt16(pcm.start+i*2,true)/32768;
  return buffer;
}

export class OmniAudioPlayer {
  constructor(context, {voice='Ryan'}={}) {
    if (!SUPPORTED_VOICES.includes(voice)) throw Error('Choose a fixed supported voice');
    this.context=context; this.voice=voice; this.nodes=new Set(); this.waiters=[];
    this.index=0; this.until=0; this.identity=null;
  }
  begin() {
    if (this.nodes.size) throw Error('Previous speech is still playing');
    this.index=0; this.until=0; this.identity=null;
  }
  enqueue(data) {
    if (data.index!==this.index || data.voice!==this.voice || data.model!==MODEL
        || data.prosody_profile!=='steady-v3' || data.backend!=='faster-ggml' || data.precision!=='BF16'
        || data.streaming!=='native-pcm-frames') throw Error('Speech identity/order changed; no fallback');
    if (this.context.state!=='running') throw Error('Unlock audio with a user gesture before starting speech');
    const audio=decodeSpeechPCM(data.audio,this.context);
    const when=playbackStart(this.context.currentTime,this.until,data);
    if (when+audio.duration-this.context.currentTime>60) throw Error('Speech playback backpressure');
    const node=this.context.createBufferSource();
    node.buffer=audio; node.playbackRate.value=1; node.connect(this.context.destination);
    this.nodes.add(node);
    node.onended=()=>{this.nodes.delete(node);node.disconnect();this.settle();};
    try { node.start(when); }
    catch (error) { this.nodes.delete(node);node.disconnect();throw error; }
    this.until=when+audio.duration; this.index++;
    return when;
  }
  settle() { if (!this.nodes.size) for (const resolve of this.waiters.splice(0)) resolve(); }
  drained() { return this.nodes.size ? new Promise(resolve=>this.waiters.push(resolve)) : Promise.resolve(); }
  stop() {
    for (const node of this.nodes) {node.onended=null;try {node.stop();} catch {} node.disconnect();}
    this.nodes.clear();this.until=0;this.settle();
  }
}

export async function consumeSpeech(response, {player,onEvent=()=>{},isCurrent=()=>true}={}) {
  if (!response.ok) {
    const error=Error(`Voice HTTP ${response.status}; no automatic retry`);
    error.status=response.status;
    throw error;
  }
  if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body)
    throw Error('Expected streaming voice events');
  let done=null, terminal=false;
  const parser=new SSEParser((name,data)=>{
    if (!isCurrent()) throw Error('Speech cancelled');
    if (terminal) throw Error('Voice data after terminal event');
    if (name==='error' || name==='retry') {
      const error=Error(name==='retry'?'Voice busy; retain text for manual retry':'Speech failed; no automatic replay');
      error.retry=name==='retry'?data:null;throw error;
    }
    if (name==='audio') player?.enqueue(data);
    if (name==='done') {done=data;terminal=true;}
    onEvent(name,data);
  });
  const reader=response.body.getReader(), decoder=new TextDecoder('utf-8',{fatal:true});
  try {
    while (true) {
      const row=await reader.read();
      if (row.done) {parser.feed(decoder.decode());break;}
      parser.feed(decoder.decode(row.value,{stream:true}));
    }
    if (!terminal || parser.buffer.trim()) throw Error('Speech stream ended incompletely');
    await player?.drained();
    return done;
  } catch (error) {
    if(isCurrent())player?.stop();await reader.cancel().catch(()=>{});throw error;
  } finally {reader.releaseLock();}
}

export class OmniSpeechClient {
  constructor({context,voice='Ryan',character,appId,turnUrl='/voice/api/turn',sessionUrl='/voice/api/speech/sessions',
               headers={'X-Voice-Demo':'1'},onEvent=()=>{},onError=()=>{},fetcher=globalThis.fetch}={}) {
    if (!/^[\w.-]{1,64}$/.test(appId||'')) throw Error('Use a non-personal appId');
    Object.assign(this,{voice,appId,turnUrl,sessionUrl,headers,onEvent,onError,fetcher});
    this.player=new OmniAudioPlayer(context,{voice});
    // Snapshot and lock the persona for this client's conversation, not each
    // sentence. The server validates bounds; only respond() sends it to LLM.
    if(character!==undefined && (!character || typeof character!=='object' || Array.isArray(character)
      || Object.entries(character).some(([k,v])=>!['name','identity','purpose','personality','speaking_style'].includes(k)
        || typeof v!=='string' || !v.trim()))) throw Error('Invalid conversation character');
    Object.defineProperty(this,'character',{value:character===undefined?undefined:Object.freeze({...character}),enumerable:true});
    Object.defineProperty(this,'voice',{value:voice,writable:false});
    this.active=false;this.closed=false;this.sequence=0;this.pending=0;this.epoch=0;this.uploads=Promise.resolve();
  }
  begin() {
    if (this.active) throw Error('Speech already active');
    this.player.begin();this.active=true;this.closed=false;this.finished=false;
    this.epoch++;this.pending=0;
    this.abort=new AbortController();this.sequence=0;this.url=null;this.uploads=Promise.resolve();
  }
  async request(url,method,body) {
    const response=await this.fetcher(url,{method,headers:{...this.headers,'Content-Type':'application/json'},
      signal:this.abort.signal,body:body===undefined?undefined:JSON.stringify(body)});
    if (!response.ok) {const e=Error(`Voice HTTP ${response.status}; no automatic retry`);e.status=response.status;throw e;}
    return response;
  }
  speak(text) {return this.runTurn({text,tts_only:true,sentence_speech:false});}
  respond(input) {
    if (!input || Object.keys(input).some(k=>!['text','audio','history','system','language','llm_route','reasoning_effort'].includes(k)))
      throw Error('Use speech sessions for application-owned tools; respond accepts conversation input only');
    if(this.character && 'system' in input) throw Error('Choose a pinned character or system, not both');
    return this.runTurn({...input,...(this.character?{character:this.character}:{})});
  }
  async runTurn(input) {
    this.begin();
    const epoch=this.epoch;
    try {
      const response=await this.request(this.turnUrl,'POST',{
        ...input,model:'omni-voice',voice:this.voice,app_id:this.appId});
      if(epoch!==this.epoch)throw Error('Speech cancelled');
      const done=await consumeSpeech(response,{player:this.player,onEvent:this.onEvent,isCurrent:()=>epoch===this.epoch});
      if (epoch!==this.epoch) throw Error('Speech cancelled');
      return done;
    } catch (error) {if(epoch===this.epoch)await this.stop();throw error;}
    finally {if(epoch===this.epoch)this.active=false;}
  }
  async start() {
    this.begin();
    const epoch=this.epoch;
    try {
      const r=await this.request(this.sessionUrl,'POST',{model:'omni-voice',voice:this.voice,app_id:this.appId});
      const s=await r.json();
      if(epoch!==this.epoch)throw Error('Speech cancelled');
      if (s.protocol!==SPEECH_PROTOCOL || !/^[a-f0-9]{32}$/.test(s.session_id) || s.voice!==this.voice)
        throw Error('Unified speech session not supported; upgrade gateway, no fallback');
      this.url=this.sessionUrl+'/'+s.session_id;
      const response=await this.request(this.url+'/events','GET');
      if(epoch!==this.epoch)throw Error('Speech cancelled');
      this.reading=consumeSpeech(response,{player:this.player,onEvent:this.onEvent,isCurrent:()=>epoch===this.epoch});
      this.reading.catch(error=>{if(!this.closed&&epoch===this.epoch){void this.stop();this.onError(error);}});
      return s;
    } catch (error) {if(epoch===this.epoch)await this.stop();throw error;}
  }
  send(type, fields={}) {
    if (!this.url || this.closed || this.finished) throw Error('No accepting speech session');
    if (this.pending>=8) throw Error('Speech upload backpressure; await previous text()');
    this.pending++;const sequence=this.sequence++,epoch=this.epoch,url=this.url;
    if (type==='finish') this.finished=true;
    const operation=this.uploads.then(async()=>{
      if(this.closed||epoch!==this.epoch)throw Error('Speech cancelled');
      const r=await this.request(url+'/input','POST',{sequence,type,...fields}), ack=await r.json();
      if (ack.next_sequence!==sequence+1) throw Error('Speech sequence mismatch');
      return ack;
    }).finally(()=>{if(epoch===this.epoch)this.pending--;});
    this.uploads=operation;
    operation.catch(error=>{if(!this.closed&&epoch===this.epoch){void this.stop();this.onError(error);}});
    return operation;
  }
  text(delta,{final=false}={}) {return this.send('text',{delta,final});}
  commit() {return this.send('commit');}
  toolWait() {return this.send('tool_wait');}
  toolDone() {return this.send('tool_done');}
  async finish() {
    const epoch=this.epoch;
    await this.send('finish');
    try {
      const done=await this.reading;
      if(epoch!==this.epoch)throw Error('Speech cancelled');
      return done;
    } finally {if(epoch===this.epoch)this.active=false;}
  }
  async stop() {
    if (this.closed) return;
    this.closed=true;this.epoch++;this.abort?.abort();this.player.stop();
    if(this.url) await this.fetcher(this.url,{method:'DELETE',headers:this.headers,
      signal:AbortSignal.timeout(3000)}).catch(()=>{});
    // An accepted native request can still be draining server-side. A new turn
    // may return 429. Never auto-replay speech or force native model shutdown.
    this.active=false;
  }
}
