/**
 * Library of functions for the "server" portion of an extension, which is
 * loaded into the background and popup pages.
 *
 * Some of these functions are asynchronous, because they may have to talk
 * to the Asana API to get results.
 */
Asana.ServerModel = {

  // Make requests to API to refresh cache at this interval.
  CACHE_REFRESH_INTERVAL_MS: 15 * 60 * 1000, // 15 minutes

  _current_xhr: undefined,

  _url_to_cached_image: {},

  /**
   * Called by the model whenever a request is made and error occurs.
   * Override to handle in a context-appropriate way. Some requests may
   * also take an `errback` parameter which will handle errors with
   * that particular request.
   *
   * @param response {dict} Response from the server.
   */
  onError: function(response) {},

  /**
   * Requests the user's preferences for the extension.
   *
   * @param callback {Function(options)} Callback on completion.
   *     options {dict} See Asana.Options for details.
   */
  options: function(callback) {
    callback(Asana.Options.loadOptions());
  },

  /**
   * Saves the user's preferences for the extension.
   *
   * @param options {dict} See Asana.Options for details.
   * @param callback {Function()} Callback on completion.
   */
  saveOptions: function(options, callback) {
    Asana.Options.saveOptions(options);
    callback();
  },

  /**
   * Determine if the user is logged in.
   *
   * @param callback {Function(is_logged_in)} Called when request complete.
   *     is_logged_in {Boolean} True iff the user is logged in to Asana.
   */
  isLoggedIn: function(callback) {
    chrome.cookies.get({
      url: Asana.ApiBridge.baseApiUrl(),
      name: 'ticket'
    }, function(cookie) {
      callback(!!(cookie && cookie.value));
    });
  },

  /**
   * Get the URL of a task given some of its data.
   *
   * @param task {dict}
   * @param callback {Function(url)}
   */
  taskViewUrl: function(task, callback) {
    // We don't know what pot to view it in so we just use the task ID
    // and Asana will choose a suitable default.
    var options = Asana.Options.loadOptions();
    var pot_id = task.id;
    var url = 'https://' + options.asana_host_port + '/0/' + pot_id + '/' + task.id;
    callback(url);
  },

  /**
   * Requests the set of workspaces the logged-in user is in.
   *
   * @param callback {Function(workspaces)} Callback on success.
   *     workspaces {dict[]}
   */
  workspaces: function(callback, errback, options) {
    var self = this;
    Asana.ApiBridge.request("GET", "/workspaces", {},
        function(response) {
          self._makeCallback(response, callback, errback);
        }, options);
  },

  /**
   * Requests the set of users in a workspace.
   *
   * @param callback {Function(users)} Callback on success.
   *     users {dict[]}
   */
  users: function(workspace_id, callback, errback, options) {
    var self = this;
    Asana.ApiBridge.request(
        "GET", "/workspaces/" + workspace_id + "/users",
        { opt_fields: "name,photo.image_60x60" },
        function(response) {
          for (user in response) {
            self._updateUser(workspace_id, user);
          }
          self._makeCallback(response, callback, errback);
        }, options);
  },

  /**
   * Requests the user record for the logged-in user.
   *
   * @param callback {Function(user)} Callback on success.
   *     user {dict[]}
   */
  me: function(callback, errback, options) {
    var self = this;
    Asana.ApiBridge.request("GET", "/users/me", {},
        function(response) {
          self._makeCallback(response, callback, errback);
        }, options);
  },

  /**
   * Makes an Asana API request to add a task in the system.
   *
   * @param task {dict} Task fields.
   * @param callback {Function(response)} Callback on success.
   */
  createTask: function(workspace_id, task, callback, errback) {
    var self = this;
    Asana.ApiBridge.request(
        "POST",
        "/workspaces/" + workspace_id + "/tasks",
        task,
        function(response) {
          self._makeCallback(response, callback, errback);
        });
  },

  /**
   * Generates a regular expression that will match strings which contain words
   * that start with the words in filter_text. The matching is case-insensitive
   * and the matching words do not need to be consecutive but they must be in
   * the same order as those in filter_text.
   *
   * @param filter_text {String|null} The input text used to generate the regular
   *  expression.
   * @returns {Regexp}
   */
  _regexpFromFilterText: function(filter_text) {
    if (!filter_text || filter_text.trim() === '') {
      return null;
    } else {
      var escaped_filter_text = RegExp.escape(
          filter_text.trim(),
          /*opt_do_not_escape_spaces=*/true);
      var parts = escaped_filter_text.trim().split(/\s+/).map(function(word) {
        return "(" + word + ")";
      }).join("(.*\\s+)");
      return new RegExp("(?:\\b|^|(?=\\W))" + parts, "i");
    }
  },

  _filterUsers: function (workspace_id, query) {
    var regexp = this._regexpFromFilterText(query);
    var users = [];

    for ( user_id in this._known_users[workspace_id] ) {
      users.push(this._known_users[workspace_id][user_id]);
    }

    return users.filter(function(user) {
      if (regexp !== null) {
        var parts = user.name.split(regexp);
        return parts.length > 1;
      } else {
        return user.name.trim() !== "";  // no filter
      }
    });
  },

  /**
   * Requests type-ahead completions for a query.
   */
  userTypeAhead: function(workspace_id, query, callback, errback) {
    var self = this;

    if (this._current_xhr) {
      this._current_xhr.abort();
    }

    this._current_xhr = Asana.ApiBridge.request(
      "GET",
      "/workspaces/" + workspace_id + "/typeahead",
      {
        type: 'user',
        query: query,
        count: 10,
        opt_fields: "name,photo.image_60x60",
      },
      function(response) {
        self._makeCallback(
          response,
          function (users) {
            users.forEach(function (user) {
              self._updateUser(workspace_id, user);
            });
            callback(users);
          },
          errback);
      },
      {
        miss_cache: true,
      });
    return this._filterUsers(workspace_id, query);
  },

  logEvent: function(event) {
    Asana.ApiBridge.request(
        "POST",
        "/logs",
        event,
        function(response) {});
  },

  /**
   * All the users that have been seen so far, keyed by workspace and user.
   */
  _known_users: {},

  _updateUser: function(workspace_id, user) {
    this._known_users[workspace_id] = this._known_users[workspace_id] || {}
    this._known_users[workspace_id][user.id] = user;
    this._cacheUserPhoto(user);
  },

  _makeCallback: function(response, callback, errback) {
    if (response.errors) {
      (errback || this.onError).call(null, response);
    } else {
      callback(response.data);
    }
  },

  _cacheUserPhoto: function(user) {
    var me = this;
    if (user.photo) {
      var url = user.photo.image_60x60;
      if (!(url in me._url_to_cached_image)) {
        var image = new Image();
        image.src = url;
        me._url_to_cached_image[url] = image;
      }
    }
  },

  /**
   * Start fetching all the data needed by the extension so it is available
   * whenever a popup is opened.
   */
  startPrimingCache: function() {
    var me = this;
    me._cache_refresh_interval = setInterval(function() {
      me.refreshCache();
    }, me.CACHE_REFRESH_INTERVAL_MS);
    me.refreshCache();
  },

  refreshCache: function() {
    var me = this;
    // Fetch logged-in user.
    me.me(function(user) {
      if (!user.errors) {
        // Fetch list of workspaces.
        me.workspaces(function(workspaces) {}, null, { miss_cache: true })
      }
    }, null, { miss_cache: true });
  }
};
