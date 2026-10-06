// Small read-only Supabase Realtime client using its documented JSON protocol.
// It subscribes only to a batch-status row; no candle-by-candle subscriptions.
export class FeedNotifications {
  constructor({url,key,onBatch=()=>{},onStatus=()=>{},socketFactory=url=>new WebSocket(url)}) {
    Object.assign(this,{url,key,onBatch,onStatus,socketFactory});
    this.topic='realtime:perfect-view-arrivals';this.socket=null;this.running=false;this.ready=false;
    this.ref=0;this.delay=1000;this.lastBatch=null;this.heartbeatRef=null;
  }
  status(value){if(this.ready!==value){this.ready=value;this.onStatus(value);}}
  send(event,payload={},topic=this.topic,join_ref=this.joinRef){
    if(this.socket?.readyState!==1)return null;
    const ref=String(++this.ref);this.socket.send(JSON.stringify({topic,event,payload,ref,join_ref}));return ref;
  }
  start(){if(this.running || !this.url || !this.key)return;this.running=true;this.connect();}
  clearTimers(){clearTimeout(this.joinTimer);clearInterval(this.heartbeat);clearTimeout(this.retryTimer);}
  stop(){this.running=false;this.clearTimers();const socket=this.socket;this.socket=null;socket?.close();this.status(false);}
  connect(){
    if(!this.running)return;
    let socket;
    try{
      const url=new URL('/realtime/v1/websocket',this.url);url.protocol='wss:';
      url.searchParams.set('apikey',this.key);url.searchParams.set('vsn','1.0.0');url.searchParams.set('log_level','error');
      socket=this.socketFactory(url.href);this.socket=socket;
    }catch{this.retry();return;}
    socket.onopen=()=>{
      if(socket!==this.socket || !this.running)return;
      this.joinRef=String(this.ref+1);
      this.send('phx_join',{access_token:this.key,config:{private:false,broadcast:{ack:false,self:false},presence:{enabled:false},postgres_changes:[{event:'UPDATE',schema:'public',table:'perfect_view_feed_status',filter:'id=eq.1'}]}});
      this.joinTimer=setTimeout(()=>socket.close(),8000);
      this.heartbeatRef=null;
      this.heartbeat=setInterval(()=>{
        if(socket!==this.socket)return;
        if(this.heartbeatRef){socket.close();return;}
        this.heartbeatRef=this.send('heartbeat',{},'phoenix',null);
      },20000);
    };
    socket.onmessage=event=>{
      if(socket!==this.socket || !this.running || typeof event.data!=='string' || event.data.length>65536)return;
      let message;try{message=JSON.parse(event.data);}catch{return;}
      if(message.event==='phx_reply' && message.ref===this.heartbeatRef){this.heartbeatRef=null;return;}
      if(message.topic!==this.topic)return;
      if(message.event==='phx_reply' && message.ref===this.joinRef){
        if(message.payload?.status!=='ok'){socket.close();return;}
        clearTimeout(this.joinTimer);this.delay=1000;this.status(true);return;
      }
      if(message.event==='system' && message.payload?.status==='error'){socket.close();return;}
      if(message.event==='phx_error' || message.event==='phx_close'){socket.close();return;}
      const data=message.payload?.data,record=data?.record;
      if(message.event==='postgres_changes' && data?.schema==='public' && data?.table==='perfect_view_feed_status' && data?.type==='UPDATE' && record?.id===1 && typeof record.batch_id==='string' && record.batch_id!==this.lastBatch){
        this.lastBatch=record.batch_id;this.onBatch(record.batch_id);
      }
    };
    socket.onerror=()=>socket.close();
    socket.onclose=()=>{if(socket!==this.socket)return;this.socket=null;this.clearTimers();this.status(false);this.retry();};
  }
  retry(){if(!this.running)return;clearTimeout(this.retryTimer);this.retryTimer=setTimeout(()=>this.connect(),this.delay);this.delay=Math.min(30000,this.delay*2);}
}
export function nextFeedCheck(now,seconds=30,phaseSeconds=5){
 const period=seconds*1000,phase=phaseSeconds*1000;
 return Math.max(250,(Math.floor((now-phase)/period)+1)*period+phase-now);
}
