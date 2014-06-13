define([
  'jquery', 'underscore', 'peerjs', 'net/BbsNetwork', 'net/RequestDispatcher', 'utils/Utils'
], function($, _, Peer, BbsNetwork, RequestDispatcher, Utils) {
  var NetworkAgent = function(config) {
    var self = this;

    this._config = config;
    this._threadListNetwork = new BbsNetwork(this._replacePeerId(
      config, 'T'
    ), function(fromPeerId, request, callback) {
      self._onRequestReceived(fromPeerId, request, callback);
    });
    this._threadNetworks = {};
    this._requestDispatcher = new RequestDispatcher();
    this._peers = [];
  };

  NetworkAgent.prototype = {
    createNetwork: function(callback) {
      this._threadListNetwork.createNetwork(callback);
    },

    joinNetwork: function(callback) {
      var self = this;

      Utils.debug("Trying to join thread list network.");

      this._getBootstrapIds(function(bootstrapIds) {
        self._peers = bootstrapIds;

        if (_.isEmpty(bootstrapIds)) {
          self.createNetwork(callback);
          return;
        }

        var retryJoinNetwork = function(bootstrapIds, callback) {
          if (_.isEmpty(bootstrapIds)) {
            return callback(null, new Error("Failed to join network."));
          }

          self._threadListNetwork.joinNetwork(_.first(bootstrapIds), function(peerId, error) {
            if (error) {
              Utils.debug("Failed to connect to", _.first(bootstrapIds), "(", error, "). Retry next peer.");
              retryJoinNetwork(_.rest(bootstrapIds), callback);
              return;
            }

            Utils.debug("Joining thread list network succeeded.");

            callback(peerId);
          });
        };
        retryJoinNetwork(bootstrapIds, callback);
      });
    },

    leaveNetwork: function() {
      var self = this;

      _.each(_.keys(this._threadNetworks), function(threadId) {
        self.leaveThreadNetwork(threadId);
      });
      this._threadListNetwork.leaveNetwork();

      Utils.debug("Left thread list network.");
    },

    fetchThreads: function(callback) {
      this._threadListNetwork.fetchThreads(callback);
    },

    spreadThread: function(threadInfo) {
      this._threadListNetwork.spreadThread(threadInfo);
    },

    fetchMessages: function(threadId, callback) {
      if (!_.has(this._threadNetworks, threadId)) {
        return callback(new Error("Unknown thread ID: " + threadId));
      }

      this._threadNetworks[threadId].fetchMessages(threadId, callback);
    },

    spreadMessage: function(messageInfo) {
      this._threadNetworks[messageInfo.threadId].spreadMessage(messageInfo);
    },

    joinThreadNetwork: function(threadId, callback) {
      var self = this;

      if (_.has(this._threadNetworks, threadId)) {
        return callback();
      }

      Utils.debug("Trying to join thread network (thread ID", threadId, ")");

      var threadNetwork = new BbsNetwork(this._replacePeerId(
        this._config, 't'
      ), function(fromPeerId, request, callback) {
        self._onRequestReceived(fromPeerId, request, callback);
      });
      this._threadNetworks[threadId] = threadNetwork;

      this._threadListNetwork.retrieveEntries(threadId, function(bootstrapIds, error) {
        if (error) {
          delete self._threadNetworks[threadId];
          return callback(new Error("Failed to retrieve bootstrap IDs:", error));
        }

        Utils.debug("[joinThreadNetwork] bootstrapIds:", bootstrapIds.toString());

        bootstrapIds = _.filter(bootstrapIds, function(id) {
          return Utils.isNonemptyString(id) && id.charAt(0) === 't';
        });

        if (_.isEmpty(bootstrapIds)) {
          threadNetwork.createNetwork(function(peerId, error) {
            if (error) {
              delete self._threadNetworks[threadId];
              return callback(error);
            }

            Utils.debug("Created thread network (thread ID:", threadId, ")");

            self._threadListNetwork.insertEntry(threadId, peerId);
            callback();
          });
          return;
        }

        var retryJoinNetwork = function(bootstrapIds, callback) {
          if (_.isEmpty(bootstrapIds)) {
            return callback(null, new Error("No peer ID to join is left."));
          }

          threadNetwork.joinNetwork(_.first(bootstrapIds), function(peerId, error) {
            if (error) {
              Utils.debug("Failed to connect to " + _.first(bootstrapIds), ". Retry next peer.");
              return retryJoinNetwork(_.rest(bootstrapIds), callback);
            }

            callback(peerId);
          });
        };

        retryJoinNetwork(bootstrapIds, function(peerId, error) {
          if (error) {
            delete self._threadNetworks[threadId];
            return callback(error);
          }

          Utils.debug("Joining thread network succeeded (thread ID:", threadId, ")");

          self._threadListNetwork.insertEntry(threadId, peerId);
          callback();
        });
      });
    },

    leaveThreadNetwork: function(threadId) {
      if (!_.has(this._threadNetworks, threadId)) {
        throw new Error("Unknown thread ID: " + threadId);
      }
      this._threadListNetwork.removeEntry(threadId, this._threadNetworks[threadId].getPeerId());
      this._threadNetworks[threadId].leaveNetwork();
      delete this._threadNetworks[threadId];

      Utils.debug("Left thread network (thread ID:", threadId, ")");
    },

    _replacePeerId: function(config, prefix) {
      config.peer.id = prefix + (Math.random().toString(36) + '0000000000000000000').substr(2, 16);
      return config;
    },

    _getBootstrapIds: function(callback) {
      var options = this._config.peer.options;
      var url = 'http://' + options.host + ':' + options.port + '/' + options.key + '/peers';
      $.ajax({
        url: url,
        success: function(peers) {
          if (!_.isArray(peers) || _.isEmpty(peers)) {
            Utils.debug("Retrieved no peer IDs.");
            return callback([]);
          }

          Utils.debug("[_getBootstrapIds] peers:", peers);

          peers = _.filter(peers, function(peer) { return peer.charAt(0) === 'T'; });

          callback(peers);
        },
        error: function(xhr, status, error) {
          console.log("Failed to retrieve peers: " + error);
          callback([]);
        }
      });
    },

    _onRequestReceived: function(fromPeerId, request, callback) {
      this._requestDispatcher.dispatch(fromPeerId, request, callback);
    },

    getJoiningThreadIds: function() {
      return _.keys(this._threadNetworks);
    },

    getPeerId: function(threadId) {
      if (!threadId) {
        return this._threadListNetwork.getPeerId();
      }
      if (!_.has(this._threadNetworks, threadId)) {
        throw new Error("Unknown thread ID: " + threadId);
      }
      return this._threadNetworks[threadId].getPeerId();
    },

    getPeers: function() {
      return this._peers;
    },

    getDirectConnectedPeers: function(threadId) {
      if (!threadId) {
        return this._threadListNetwork.getDirectConnectedPeers();
      }
      if (!_.has(this._threadNetworks, threadId)) {
        throw new Error("Unknown thread ID: " + threadId);
      }
      return this._threadNetworks[threadId].getDirectConnectedPeers();
    },

    getState: function(threadId) {
      if (!threadId) {
        return this._threadListNetwork.getState();
      }
      if (!_.has(this._threadNetworks, threadId)) {
        throw new Error("Unknown thread ID: " + threadId);
      }
      return this._threadNetworks[threadId].getState();
    }
  };

  return NetworkAgent;
});