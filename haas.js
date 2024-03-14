module.exports = function(RED) {
  const { Telnet } = require('telnet-client');

  const CONNECTION_STATUS = {
    DISCONNECTED : 0,
    CONNECTED : 1,
    CONNECTING : 2,
    RECONNECTING : 3,
    ERROR : 4,
  };

  class HaasConnection extends Telnet {
    constructor(host, port, timeout) {
      super();

      // Assign class variables
      this.host = host;
      this.port = port;
      this.timeout = timeout;
      this.connection_name = host + ':' + port;
      this.statusObservers = [];
      this.dataObservers = [];
      this.connecting = false;
      this.will_destroy = false;
      this.reconnect_timeout = null;

      // Attach event listeners
      this.on('ready', prompt => {
        console.log('[HAAS] Connected to', this.host, this.port);
        this.broadcastStatus(CONNECTION_STATUS.CONNECTED);
      });
      this.on('timeout', () => {
        console.log('[HAAS] Socket timeout with', this.host, this.port);
        this.end();
      });
      this.on('close', () => {
        let that = this;
        console.log('[HAAS] Connection closed with', this.host, this.port);
        this.broadcastStatus(CONNECTION_STATUS.DISCONNECTED);
        this.removeAllListeners('failedlogin');

        if (!this.will_destroy) {
          // Try to reconnect to server
          this.reconnect_timeout = setTimeout(function() {
            if (!that) return;
            that.broadcastStatus(CONNECTION_STATUS.RECONNECTING);
            that.connect();
          }, 1000);
        }
      });
      this.on('data', data => {
        this.broadcastData(data);
      })
    }

    connect() {
      if (this.connecting || this.isConnected()) {
        console.log('[HAAS] Connection already in progress or established to', this.host, this.port);
        return;
      }

      this.connecting = true;
      console.log('[HAAS] Try to connect to', this.host, this.port);
      let that = this;
      super.connect({
        host: this.host,
        port: this.port,
        shellPrompt: '>', // or negotiationMandatory: false
        timeout: this.timeout
      })
      .then(() => {
        this.connecting = false;
      })
      .catch(error => {
        console.log('[HAAS] Failed to connect to', this.host, this.port);
        that.broadcastStatus(CONNECTION_STATUS.ERROR);
        this.connecting = false;
      });
    }
    kill() {
      console.log('[HAAS] Destroy connection to', this.host, this.port);
      clearTimeout(this.reconnect_timeout);
      this.will_destroy = true;
      if (this.socket) this.destroy();
    }
    isConnected() {
      return this.socket && !this.socket.destroyed;
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
        context.haas_connections[uuid] = new HaasConnection(address, port, timeOut);
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
        context.haas_connections[uuid] = new HaasConnection(address, port, timeOut);
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
        HAAS.exec(msg.payload, (err, response) => {
          console.log(response, err);
          if (!!err) node.send([response, null]);
          else node.send([null, err]);
        })
        .catch(error => {
          onHaasStatus(CONNECTION_STATUS.ERROR);
          let msg = { payload : 'Not connected to HAAS server' };
          node.send([null, msg]);
        })
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
