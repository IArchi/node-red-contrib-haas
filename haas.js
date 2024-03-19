module.exports = function(RED) {
  const CONNECTION_STATUS = {
    DISCONNECTED : 0,
    CONNECTED : 1,
    CONNECTING : 2,
    RECONNECTING : 3,
    ERROR : 4,
  };

  const net = require('net');
  const EventEmitter = require('events');

  class TcpClient extends EventEmitter {
    constructor(host, port, prompt='') {
      super();
      this.host = host;
      this.port = port;
      this.prompt = prompt;
      this.socket = new net.Socket();
      this.statusObservers = [];
      this.dataObservers = [];
      this.connecting = false;
      this.will_destroy = false;
      this.reconnect_timeout = null;
      this.commandQueue = [];
      this.isProcessing = false;
      this.hasBeenInitialized = false;

      this.socket.on('data', (data) => {
        if (!this.hasBeenInitialized && data.toString().indexOf(this.prompt) > -1) {
          console.log('[HAAS] Prompt detected.')
          this.hasBeenInitialized = true;
          return;
        }
        if (this.commandQueue.length) {
          const { nodeId, command, callback } = this.commandQueue.shift();

          // Format response
          let dataStr = data.toString();
          dataStr = dataStr.replace(/\r/gm, '');
          let dataList = dataStr.split(/\n|>/gm);
          dataList = dataList.filter((el) => {return el.length});
          if (dataList.length == 0) callback(nodeId, null, {command: command, payload: ''});
          else callback(nodeId, null, {command: command, payload: dataList[0]});

          // Process next commands
          this.isProcessing = false;
          this.processQueue();
        }
        else {
          let dataStr = data.toString().replace(/(\r\n|\n\r)*$/, '');
          this.broadcastData(dataStr);
        }
      });
      this.socket.on('close', () => {
        console.log('[HAAS] Connection closed with', this.host, this.port);
        this.broadcastStatus(CONNECTION_STATUS.DISCONNECTED);
        this.removeAllListeners('connect');
        this.socket.removeAllListeners('connect');
        this.connecting = false;
        this.hasBeenInitialized = true;
        this.cmd_queue = [];

        // Purge queued commands
        while (this.commandQueue.length) {
          const { nodeId, command, callback } = this.commandQueue.shift();
          callback(nodeId, {command: command, error: 'Disconnected'}, null);
        }
        this.isProcessing = false;

        if (!this.will_destroy) {
          let that = this;
          this.reconnect_timeout = setTimeout(function() {
            if (!that) return;
            that.broadcastStatus(CONNECTION_STATUS.RECONNECTING);
            that.connect();
          }, 1000);
        }
      });
      this.socket.on('error', (err) => {
        console.log('[HAAS] Connection error with', this.host, this.port);
        this.broadcastStatus(CONNECTION_STATUS.ERROR);
      });
      this.socket.on('timeout', (err) => {
        console.error('Timeout error:', err);
        this.emit('timeout', err);
      });
    }
    connect() {
      if (this.connecting) {
        console.log('[HAAS] Connection already in progress or established to', this.host, this.port);
        return;
      }

      this.connecting = true;
      this.socket.connect({
        host: this.host,
        port: this.port,
        keepAlive : true
      }, () => {
        console.log('[HAAS] Connected to', this.host, this.port);
        this.broadcastStatus(CONNECTION_STATUS.CONNECTED);
      });
    }
    sendCommand(nodeId, command, callback) {
      if (!this.socket || this.socket.destroyed) return callback(nodeId, {command: command, error: 'Not connected'}, null);
      this.commandQueue.push({ nodeId, command, callback });
      console.log('[HAAS] Command queued. Position:', this.commandQueue.length);
      if (!this.isProcessing) this.processQueue();
    }
    processQueue() {
      if (this.commandQueue.length === 0) {
        this.isProcessing = false;
        return;
      }
      this.isProcessing = true;
      const { nodeId, command, callback } = this.commandQueue[0];

      this.socket.write(command, () => {
        console.log('[HAAS] Command sent:', command);
      });
    }
    kill() {
      console.log('[HAAS] Destroy connection to', this.host, this.port);
      clearTimeout(this.reconnect_timeout);
      this.will_destroy = true;
      this.socket.destroy();
    }
    subscribe(sfn, dfn) {
      if (!!sfn) this.statusObservers.push(sfn);
      if (!!dfn) this.dataObservers.push(dfn);
    }
    unsubscribe(sfn, dfn) {
      if (!!sfn) this.statusObservers = this.statusObservers.filter((observer) => observer !== sfn);
      if (!!dfn) this.dataObservers = this.dataObservers.filter((observer) => observer !== dfn);
    }
    broadcastStatus(status) {
      this.statusObservers.forEach((observer) => observer(status));
    }
    broadcastData(data) {
      let msg = { payload : data };
      this.dataObservers.forEach((observer) => observer(msg));
    }
    isAlive() {
      return this.statusObservers.length > 0;
    }
    getStatusObs() {
      return this.statusObservers;
    }
  }

  /*********************************/
  /*          DPRINT NODE          */
  /*********************************/
  function dprintNode(config) {
    RED.nodes.createNode(this, config);
    var node = this;

    // Callback functions
    function onHaasStatus(status) {
      if (status === CONNECTION_STATUS.CONNECTED) node.status({ fill: 'green', shape: 'dot', text: 'Connected' });
      else if (status === CONNECTION_STATUS.CONNECTING) node.status({ fill: 'yellow', shape: 'dot', text: 'Connecting' });
      else if (status === CONNECTION_STATUS.RECONNECTING) node.status({ fill: 'yellow', shape: 'dot', text: 'Reconnecting' });
      else if (status === CONNECTION_STATUS.DISCONNECTED) node.status({ fill: 'red', shape: 'dot', text: 'Disconnected' });
      else if (status === CONNECTION_STATUS.ERROR) node.status({ fill: 'red', shape: 'dot', text: 'Error' });
      else node.status({ fill: 'grey', shape: 'ring', text: 'Idle' });
    }
    function onHaasMessage(msg) {
      node.send(msg);
    }

    function initializeConnection() {
      // Compute values
      const address = RED.util.evaluateNodeProperty(config.address, config.addresstype, node);
      const port = RED.util.evaluateNodeProperty(config.port, config.porttype, node);
      const uuid = address + ':' + port;

      if (address === undefined || port === undefined) {
        node.restart_timeout = setTimeout(initializeConnection, 1000);
        return;
      }

      // Retrieve or create connection
      const context = node.context().global;
      if (!context.haas_connections) context.haas_connections = {};
      if (!context.haas_connections[uuid]) {
        console.log('Cannot find previous connection. Create a new one');
        context.haas_connections[uuid] = new TcpClient(address, port, '>');
      }
      const HAAS = context.haas_connections[uuid];

      // Subscribe only to status changes
      HAAS.subscribe(onHaasStatus, onHaasMessage);

      // Remove callbacks when the node is destroyed
      node.on('close', function() {
        clearTimeout(node.restart_timeout);
        HAAS.unsubscribe(onHaasStatus, onHaasMessage);
        if (!HAAS.isAlive()) {
          console.log('[HAAS] Connection to ' + address + ':' + port + ' does not have any nodes attached');
          context.haas_connections[uuid].kill();
          delete context.haas_connections[uuid];
        }
        else {
          console.log('[HAAS] Connection to ' + address + ':' + port + ' still has ' + HAAS.getStatusObs().length + ' nodes attached');
        }
        node.status({});
      });

      // Try to connect to server
      HAAS.broadcastStatus(CONNECTION_STATUS.CONNECTING);
      HAAS.connect();
    }

    // Initial status
    onHaasStatus(-1);

    // Try to read values and to connect to server
    initializeConnection();
  }

  RED.nodes.registerType('haas-dprint', dprintNode, {});

  /*********************************/
  /*          COMMAND NODE         */
  /*********************************/
  function commandNode(config) {
    RED.nodes.createNode(this, config);
    var node = this;

    // Callback functions
    function onHaasStatus(status) {
      if (status === CONNECTION_STATUS.CONNECTED) node.status({ fill: 'green', shape: 'dot', text: 'Connected' });
      else if (status === CONNECTION_STATUS.CONNECTING) node.status({ fill: 'yellow', shape: 'dot', text: 'Connecting' });
      else if (status === CONNECTION_STATUS.RECONNECTING) node.status({ fill: 'yellow', shape: 'dot', text: 'Reconnecting' });
      else if (status === CONNECTION_STATUS.DISCONNECTED) node.status({ fill: 'red', shape: 'dot', text: 'Disconnected' });
      else if (status === CONNECTION_STATUS.ERROR) node.status({ fill: 'red', shape: 'dot', text: 'Error' });
      else node.status({ fill: 'grey', shape: 'ring', text: 'Idle' });
    }

    function initializeConnection() {
      // Compute values
      const address = RED.util.evaluateNodeProperty(config.address, config.addresstype, node);
      const port = RED.util.evaluateNodeProperty(config.port, config.porttype, node);
      const timeOut = parseInt(config.timeOut);
      const uuid = address + ':' + port;

      if (address === undefined || port === undefined) {
        node.restart_timeout = setTimeout(initializeConnection, 1000);
        return;
      }

      // Retrieve or create connection
      const context = node.context().global;
      if (!context.haas_connections) context.haas_connections = {};
      if (!context.haas_connections[uuid]) {
        console.log('Cannot find previous connection. Create a new one');
        context.haas_connections[uuid] = new TcpClient(address, port, '>');
      }
      const HAAS = context.haas_connections[uuid];

      // Subscribe only to status changes
      HAAS.subscribe(onHaasStatus, false);

      // Remove callbacks when the node is destroyed
      node.on('close', function() {
        HAAS.unsubscribe(onHaasStatus, false);
        if (!HAAS.isAlive()) {
          console.log('[HAAS] Connection to ' + address + ':' + port + ' does not have any nodes attached');
          context.haas_connections[uuid].kill();
          delete context.haas_connections[uuid];
        }
        else {
          console.log('[HAAS] Connection to ' + address + ':' + port + ' still has ' + HAAS.getStatusObs().length + ' nodes attached');
        }
        node.status({});
      });

      node.on('input', function(msg) {
        if (!msg.payload) return;
        HAAS.sendCommand(node.id, msg.payload, (nodeId, err, response) => {
          if (nodeId !== node.id) return;
          if (!err) return node.send([response, null]);
          else node.send([null, err]);
        });
      });

      // Try to connect to server
      HAAS.broadcastStatus(CONNECTION_STATUS.CONNECTING);
      HAAS.connect();
    }

    // Initial status
    onHaasStatus(-1);

    // Try to read values and to connect to server
    initializeConnection();
  }

  RED.nodes.registerType('haas-command', commandNode, {});
}
