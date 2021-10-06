import redipc from "../redipc.js";


Promise.resolve().then(async()=>{
	const REDIPC = await redipc.init({redis:{uri:'redis://192.168.3.29:6379/0'}, timeout:10});
	console.log("inst_id", REDIPC.id);

	REDIPC.register('hi_back', (...args:any[])=>{ console.log("Receiving hi_back:", args); return "Hi Back!"; });

	console.log("test1 say_hi:", await REDIPC.remoteCall('test1', 'say_hi', 'test1', 1, 2, 3));
	console.log("test2 say_hi:", await REDIPC.remoteCall('test2', 'say_hi', 'test2', {a:1, b:2, c:3, d:456}));
	REDIPC.on('super_event_back', (event, ...args)=>{
		console.log("Receiving event:", event, args);
	});
	await REDIPC.remoteEvent('test1', 'super_event', 1, 2, 3, 4 ,5);
	

	setTimeout(async()=>{
		await REDIPC.close();
	}, 1000);
})
.catch((e)=>{console.error("Unexpected error:", e); process.exit(1)});