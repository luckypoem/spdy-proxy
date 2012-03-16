#!/usr/bin/env node

// Setup the configuration and logging
var config = (function config() {
	var path = require('path');
	var ENV = {};
	if (!process.argv[2]) {
		console.log('Usage: "'+process.argv[0]+'" "'+process.argv[1]+'" <config-file>');
		return process.exit();
	}
	ENV.configFile = path.resolve(process.env.CONFIG || __dirname, process.argv[2] || 'config/server.json');
	ENV.configBase = path.dirname(ENV.configFile);
	try {
		ENV.config = JSON.parse(require('fs').readFileSync(ENV.configFile, 'utf-8'));
	} catch(ex) { console.log("error reading configuration: "+ENV.configFile+"\n  "+ex.message); process.exit(1); }
	ENV.config.configFile = ENV.configFile;
	ENV.config.configBase = ENV.config.configBase ? path.resolve(ENV.configBase, ENV.config.configBase) : ENV.configBase;
	ENV = ENV.config;
	ENV.name = ENV.name || path.basename(__dirname);
	ENV.baseDir = ENV.baseDir ? path.resolve(ENV.configDir, ENV.baseDir) : __dirname;
	ENV.ssl = ENV.ssl || {};
	try {
		ENV.ssl.cert = require('fs').readFileSync(path.resolve(ENV.configBase, ENV.ssl.cert || (ENV.name+'.crt')));
	} catch(ex) { console.log("error reading certificate: "+ENV.ssl.cert+"\n  "+ex.message); process.exit(1); }
	try {
		ENV.ssl.key = require('fs').readFileSync(path.resolve(ENV.configBase, ENV.ssl.key || (ENV.name+'.key')));
	} catch(ex) { console.log("error reading key: "+ENV.ssl.key+"\n  "+ex.message); process.exit(1); }
	try {
		if (ENV.ssl.ca) ENV.config.ssl.ca = require('fs').readFileSync(path.resolve(ENV.configBase, ENV.ssl.ca));
	} catch(ex) { console.log("error reading ssl-authority: "+ENV.ssl.ca+"\n  "+ex.message); process.exit(1); }
	
	ENV.port = ENV.port || (process.getuid() ? 1443 : 443);
	
	ENV.logFile = path.resolve(ENV.baseDir, ENV.logFile || (ENV.name+'.log'));
	var logging = require('simple-logging');
	logging.setUp(console, ENV.debug ? { levelize:0, source:true, pid:true, base:ENV.baseDir } : { pid:true });
	logging.stream = ENV.debug ? process.stdout : ENV.logFile;
	logging.level = ENV.logLevel;
	ENV.logLevel = logging.level;
	
	(function() {
		var levels={};
		Object.keys(ENV.logLevels || {}).forEach(function(file) {
			levels[path.resolve(ENV.baseDir)] = ENV.logLevels[file];
		});
		Object.keys(levels).forEach(function(file) {
			logging.setFileLevel(file, levels[file]);
			ENV.logLevels[file] = logging.getFileLevel(file);
		});
	})();
	
	ENV.pidFile = path.resolve(ENV.baseDir, ENV.pidFile || (ENV.name+'.pid'))
	if (require('cluster').isMaster) {
		require('fs').writeFileSync(ENV.pidFile, process.pid, 'utf-8');
		process.once('exit', function(code) {
			try { 
				require('fs').unlinkSync(ENV.pidFile);
			} catch(ex) {
				console.log("error unlinking pid-file: "+ENV.pidFile+"\n  "+ex.message);
			}
			console.log("Stopping "+ENV.name);
			logging.stream = process.stdout;
		});
		process.once('SIGINT', process.exit);
		process.once('SIGTERM', process.exit);
		console.log("starting "+ENV.name);
	} else {
		console.log("starting "+ENV.name+" worker pid:"+process.pid);
	}
	return ENV;
})();

var cluster = require('cluster');

function startMaster() {
	cluster.on('fork', function(worker) {
		console.log(config.name+" worker pid:"+worker.process.pid+" forked");
	});
	cluster.on('online', function(worker) {
		console.log(config.name+" worker pid:"+worker.process.pid+" born");
	});
	cluster.on('death', function(worker) {
		if (worker.suicide) {
			return console.log(config.name+" worker pid:"+worker.process.pid+" stopped");
		}
		console.log(config.name+" worker pid:"+worker.process.pid+" died");
		cluster.fork();
	});
	var cpus = require('os').cpus().forEach(cluster.fork.bind(cluster));
}
function startWorker() {
	var UnchunkedResponse = require('http-unchunk-stack').UnchunkedResponse
	var HttpProxy = require('http-proxy').HttpProxy;
	var proxy = new HttpProxy(config.proxy);
	var server = require('spdy').createServer(config.ssl, function(req, res) {
		var url = require('url').parse(req.url);
		url.protocol = "https:";
		url.hostname = String(req.headers.host || '');
		url.host = url.host || url.hostname.split(':');
		url.port = url.port || url.host[1];
		url.host = url.host[0];
		url.hostname = [ url.host ];
		if (url.port != 443) url.hostname.push(url.port);
		url.hostname = url.hostname.join(':');
		url = require('url').format(url);
		if (url.length > 79) url=url.substring(0, 79)+'…';
		console.info((req.isSpdy ? 'SPDY ' : 'SSL  ') + url)
		res = new UnchunkedResponse(res);
		return proxy.proxyRequest(req, res);
	});
	server.on('upgrade', function(req, socket, head) {
	  proxy.proxyWebSocketRequest(req, socket, head);
	});
	server.listen(config.port, function() {
		console.log("listening on "+config.port);
	});
	
	function stop() {
		if (server) {
			console.log(config.name+" worker "+process.pid+" closing server");
			server.close();
			server = undefined;
		}
		if (process._channel) {
			console.log(config.name+" worker "+process.pid+" diconnecting");
			process._channel.close();
			process._channel = undefined;
		}
		require('simple-logging').stream = process.stdout;
	};
	process.once('SIGTERM', stop);
	process.once('SIGINT', stop);
	process.on('exit', function() {
		console.log(config.name+" worker "+process.pid+" exiting");
	});
}

if (cluster.isMaster) {
	startMaster();
} else {
	startWorker();
}
