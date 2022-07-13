import redipc from "../redipc.js";


Promise.resolve().then(async()=>{
	const test_channel = '_redipc_test_channel_' + Math.floor(Date.now()/86400000);
	const REDIPC = await redipc.init({redis:{uri:'redis://127.0.0.1:6379/0'}, timeout:10});
	console.log("inst_id", REDIPC.id);

	await REDIPC.remoteEvent(test_channel, 'other_event_from_other_channel', '1');

	REDIPC.register('hi_back', (...args:any[])=>{ console.log("Receiving hi_back:", args); return "Hi Back!"; });

	console.log("test1 say_hi:", await REDIPC.remoteCall('test1', 'say_hi', 'test1', 1, 2, 3));
	console.log("test2 say_hi:", await REDIPC.remoteCall('test2', 'say_hi', 'test2', {a:1, b:2, c:3, d:456}));
	console.log("test3 say_hi2:", await REDIPC.remoteCall('test2', 'say_hi_error').catch(e=>e));
	REDIPC.on('super_event_back', (event, ...args)=>{
		console.log("Receiving event:", event, args);
	});
	await REDIPC.remoteEvent('test1', 'super_event', 1, 2, 3, 4 ,5);
	await REDIPC.remoteEvent(test_channel, 'other_event_from_other_channel', '2');
	

	console.log("Closing connection in 5 sec...");
	setTimeout(async()=>{
		await REDIPC.close();
		console.log("Connection closed! Terminating!");
	}, 5000);
})
.catch((e)=>{console.error("Unexpected error:", e); process.exit(1)});