var RSVP = require('rsvp'),
    _ = require('lodash');

// mongoose-mutex
// ==============

module.exports = (function() {
    function MongooseMutex(slug, options) {
        options = _.extend({ }, MongooseMutex.default, options || { });

        if(!slug || typeof slug !== 'string')
            throw new Error('A truthy string must be provided for a slug');

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

        // I had to declare instance methods in the constructor as opposed to the prototype because
        // the value for `this` was `GLOBAL` when called like `x.then(y).then(mutex.claim).then(mutex.free)`. :(
        // TODO (investigate)
        var self = this;
        // ## #claim()
        this.claim = function() {
            if(!self.idle)
                throw new Error('Cannot claim when not idle');

            self.idle = false;

            self.promise = new RSVP.Promise(function(outerResolve, outerReject) {
                // We use a nested promise so error handling won't affect any promises the user might've prepended,
                // i.e. if the user said `x.then(y).then(z).then(mutex.claim)`, `mutex.claim` would evaluate to a promise
                // which would catch things from `x`, `y` and `z` - that's bad!
                return new RSVP.Promise(function(resolve, reject) {
                    function fail(msg) { reject(new Error(msg)); }

                    var now = _.now();
                    // Timestamps are formatted as `"12345-146238912"` (where 12345 is a random integer. The second
                    // part (after the hyfen) is a unix timestamp, after which the mutex is considered expired.
                    var time = now + self.timeLimit;
                    var rand = parseInt(Math.random() * 1000000);
                    var stamp = rand + '-' + time;

                    // The upsert option makes it possible to atomically update a document, or create it if it doesn't
                    // exist. We'll take advantage of that here. However, `findOneAndUpdate` doesn't seem to return the
                    // document if it was upserted, so we need to manually search for it.
                    // TODO (verify)
                    self._model.update({ slug: self._slug }, { slug: self._slug, $push: { timestamps: stamp } }, { upsert: true }, function(err) {
                        if(err)
                            return fail('Database error: ' + JSON.stringify(err));

                        self._model.findOne({ slug: self._slug }, function(err, doc) {
                            if(err)
                                return fail('Database error: ' + JSON.stringify(err));
                            
                            if(!doc)
                                return fail('Database error: document not returned');

                            // We fail to acquire mutual exlusion IFF there exists a timestamp (other than our own) that
                            // has NOT expired yet. If we successfully acquire mutual exclusion, we should remove all
                            // old, expired timestamps if they exist. This will prevent cluttering if a programming error
                            // results in mutexes never being `#free()`d.
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
                                doc.update({ $pullAll: { timestamps: toRemove } }, function() {
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

                    // Throwing the error somehow doesn't result in the promise being rejected...
                    // Try changing this to throw and running the test suite again - there were timeouts for me. :/
                    outerReject(err);
                });
            });

            return self.promise;
        }

        // ## #free()
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

        if(!options.idle)
            this.claim();
    }

    MongooseMutex.default = {
        connection: undefined,
        idle: false,
        timeLimit: 15000
    };

    return MongooseMutex;
})();
