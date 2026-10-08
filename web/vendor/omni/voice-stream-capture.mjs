import {encodeWav,toBase64} from './voice-core.mjs';
import {VoiceStreamClient} from './voice-stream-client.mjs';

// Keeps the existing Omni mic/VAD/player UX; swaps only input transport.
export class VoiceStreamCapture {
  constructor(rate,options,{onPartial=()=>{},onError=()=>{},onConnection=()=>{},clientOptions={}}={}) {
    this.rate=rate;this.options=options;this.parts=[];this.samples=0;this.writes=Promise.resolve();
    this.closed=false;this.pending=0;this.total=0;this.failed=false;this.retained=[];
    this.body=new ReadableStream({start:c=>{this.output=c;},cancel:()=>this.stop()});
    const encoder=new TextEncoder();
    // After commit, only the turn's SSE reader handles failure/retry. Aborting
    // it through the recording callback would lose its manual-retry context.
    this.fail=e=>{if(this.closed||this.failed)return;this.failed=true;try{this.output.error(e);}catch{}
      if(!this.committing)onError(e);void this.client.stop('transport_error');};
    this.client=new VoiceStreamClient({...clientOptions,onError:this.fail,onConnection:state=>{
      this.reconnecting=state.state==='reconnecting';if(!this.closed)onConnection(state);
    },onEvent:(event,data)=>{
      if(this.closed||this.failed||this.completed)return;
      if(event==='transcript_partial')onPartial(data);
      this.output.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      if(['done','error','retry'].includes(event)){
        this.output.close();this.completed=true;
        if(event==='done')this.retained=[];
        if(!this.committing && event!=='done')onError(Error(data.message||'Voice session failed'));
      }
    }});
    this.ready=this.client.start(options);this.ready.catch(this.fail);
  }
  send(frame) {
    this.sendPCM(encodeWav(frame,this.rate).slice(44));
  }
  sendPCM(pcm) {
    this.pending+=pcm.byteLength;
    this.retained.push(pcm);
    if(this.pending>960000)throw Error('Maximum 30-second buffered recording reached');
    this.writes=this.writes.then(async()=>{await this.ready;if(this.closed)throw Error('Stopped');await this.client.append(toBase64(pcm));})
      .finally(()=>{this.pending-=pcm.byteLength;});
    this.writes.catch(this.fail);
  }
  recording() {
    const pcm=this.retained.slice();
    if(this.samples){const tail=new Float32Array(this.samples);let p=0;
      for(const part of this.parts){tail.set(part,p);p+=part.length;}pcm.push(encodeWav(tail,this.rate).slice(44));}
    return pcm.length?{pcm,options:this.options}:null;
  }
  static fromRecording(recording,callbacks={}) {
    const capture=new VoiceStreamCapture(16000,recording.options,callbacks);
    for(const pcm of recording.pcm)capture.sendPCM(pcm);
    return capture;
  }
  push(frame) {
    if(this.closed||this.failed)return;
    this.total+=frame.length;if(this.total/this.rate>30)throw Error('Maximum 30 seconds per voice turn');
    this.parts.push(frame);this.samples+=frame.length;
    const block=Math.round(this.rate*.25);
    while(this.samples>=block){const all=new Float32Array(this.samples);let p=0;for(const part of this.parts){all.set(part,p);p+=part.length;}
      this.send(all.slice(0,block));const tail=all.slice(block);this.parts=tail.length?[tail]:[];this.samples=tail.length;}
  }
  async response(signal) {
    this.committing=true;
    if(signal.aborted){this.stop();throw Error('Stopped');}
    signal.addEventListener('abort',()=>this.stop(),{once:true});
    if(this.samples){const all=new Float32Array(this.samples);let p=0;for(const part of this.parts){all.set(part,p);p+=part.length;}this.send(all);this.parts=[];this.samples=0;}
    await this.ready;await this.writes;await this.client.commit();
    return new Response(this.body,{headers:{'Content-Type':'text/event-stream'}});
  }
  stop(reason='client_stop') {
    if(this.closed)return;this.closed=true;this.parts=[];this.samples=0;this.retained=[];
    void this.client.stop(reason);if(!this.completed)try{this.output.error(Error('Stopped'));}catch{}
  }
}
