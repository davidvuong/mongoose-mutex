var RSVP = require('rsvp'),
    _ = require('lodash');

// mongoose-mutex
// ==============

module.exports = (function() {
    function MongooseMutex(slug, options) {
        options = _.extend({ }, MongooseMutex.default, options || { });

        if(!slug || typeof slug !== 'string')
            throw new Error('A truthy string must be provided for a slug');

        var self = this;
        // I had to declare instance methods in the constructor as opposed to the prototype because
        // the value for `this` was `GLOBAL` when called like x.then(y).then(mutex.go).then(mutex.free) :(
        // TODO (investigate)
        this.go = function() {
            if(!self.idle)
                throw new Error('Cannot go when not idle');

            self.idle = false;

            self.promise = new RSVP.Promise(function(outerResolve, outerReject) {
                // We use a nested promise so error handling  won't affect any promises the user might've prepended
                // i.e. if the user said x.then(y).then(z).then(mutex.go), mutex.go would return a promise which would
                // catch things from x, y and z - that's bad!
                return new RSVP.Promise(function(resolve, reject) {
                    var now = _.now();
                    var time = now + self.timeLimit;
                    var rand = parseInt(Math.random() * 1000000);
                    var stamp = rand + '-' + time;

                    function fail(msg) {
                        reject(new Error(msg));
                    }

                    self._model.update({ slug: self._slug }, { slug: self._slug, $push: { timestamps: stamp } }, { upsert: true }, function(err) {
                        if(err)
                            return fail('Database error: ' + JSON.stringify(err));

                        // findOneAndUpdate doesn't seem to return the document if it was upserted, so we need to manually search for it
                        // TODO (verify)
                        self._model.findOne({ slug: self._slug }, function(err, doc) {
                            if(err)
                                return fail('Database error: ' + JSON.stringify(err));
                            
                            if(!doc)
                                return fail('Database error: document not returned');

                            var toRemove = [];
                            var allGood = true;
                            _.forEach(doc.timestamps, function(otherStamp) {
                                if(!allGood || stamp === otherStamp)
                                    return;

                                var split = otherStamp.split('-');
                                var otherTime = parseInt(split[1]);

                                if(now <= otherTime)
                                    allGood = false;
                                else
                                    toRemove.push(otherStamp);
                            });

                            if(!allGood)
                                toRemove = [stamp];

                            if(toRemove.length != 0) {
                                doc.update({ $pullAll: { timestamps: toRemove } }, function(err) {
                                    if(allGood)
                                        resolve();
                                    else
                                        fail('Failed to acquire mutual exclusion');
                                });
                            } else
                                resolve();
                        });
                    });
                }).then(function() {
                    outerResolve(self.free);
                }, function(err) {
                    self.idle = true;

                    outerReject(err);
                });
            });

            return self.promise;
        }

        this.free = function() {
            if(self.idle)
                throw new Error('Cannot free idle mutex');

            return self.promise.then(function() {
                return new RSVP.Promise(function(resolve) {
                    self._model.remove({ slug: self._slug }, function(err) {
                        self.promise = undefined;
                        self.idle = true;

                        if(err)
                            throw new Error('Database error: ' + JSON.stringify(err));

                        resolve();
                    });
                });
            });
        };

        this.connection = options.connection;
        if(!this.connection)
            throw new Error('No mongoose connection');

        this._slug = slug;

        // TODO (find a cleaner way of doing this)
        try {
            this._model = this.connection.model('MongooseMutex');
        } catch(err) {
            if(err.name !== 'MissingSchemaError')
                throw err;

            this._model = this.connection.model('MongooseMutex', { slug: { type: String, unique: true }, timestamps: [String] });
        }

        this.timeLimit = options.timeLimit;
        this.promise = undefined;

        this.idle = true;
        if(!options.idle)
            this.go();
    }

    MongooseMutex.default = {
        connection: undefined,
        idle: false,
        timeLimit: 15000
    };

    return MongooseMutex;
})();
