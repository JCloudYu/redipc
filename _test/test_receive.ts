import redipc from "../redipc.js";


Promise.resolve().then(async()=>{
	const REDIPC = await redipc.init({
		silent:true, // Stop logging error to screen when processing call request
		redis:{uri:'redis://127.0.0.1:6379/0'}, 
		channels:['test1', 'test2'], 
		timeout:5
	});
	console.log("inst_id", REDIPC.id);

	REDIPC.register('say_hi', (...args:any[])=>{ console.log("Received say_hi:", args); return "Hi!"; });
	REDIPC.register('say_hi_error', (...args:any[])=>{ 
		console.log("Received say_hi_error! Triggering exception...");
		throw new Error("Super error!");
	});
	REDIPC.on('super_event', async(event, ...args)=>{
		console.log("Receiving event:", event, args);
		await REDIPC.remoteEvent(event.src, 'super_event_back', ...args, 'a', 'b', 'c', 'd', 'e');
		console.log("test1 say_hi:", await REDIPC.remoteCall(event.src, 'hi_back', 'hi', 'back', 3, 2, 1));
	});
})
.catch((e)=>{console.error("Unexpected error:", e); process.exit(1)});