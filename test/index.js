var should = require('should'),
    RSVP = require('rsvp'),
    mongoose = require('mongoose'),
    _ = require('lodash'),
    
    MongooseMutex = require('../index'),
    util = require('./lib/util');

var mutexTimeLimit = 1000;

mongoose.connect('mongodb://localhost/test');

// TODO (wrap all tests in util.allErrors)

describe('MongooseMutex', function() {
    beforeEach(function(done) {
        var total = Object.keys(mongoose.connection.collections).length;
        if(total === 0) return done();

        var removed = 0;
        for(var i in mongoose.connection.collections) {
            mongoose.connection.collections[i].remove(function() {
                // TODO (handle errors)
                if(++removed === total)
                    done();
            });
        }
    });
    
    describe('construction', function() {
        it('should throw if no explicit or default mongoose connection is provided', function() {
            (function() {
                new MongooseMutex('n/a', { idle: true });
            }).should.throw('No mongoose connection');
        });
        
        it('should not throw if an explicit mongoose connection is provided', function() {
            (function() {
                new MongooseMutex('n/a', { idle: true, connection: mongoose });
            }).should.not.throw();
        });
        
        it('should not throw if a default mongoose connection is provided', function() {
            MongooseMutex.default.connection = mongoose;
            
            (function() {
                new MongooseMutex('n/a', { idle: true });
            }).should.not.throw();
        });

        it('should take values from MongooseMutex.default which can be overridden individually', function() {
            var slug = 'defaultTest'
              , weirdTimeLimit = 10
              , promiseType = require('q')
              ;

            var defaults = _.clone(MongooseMutex.default);

            MongooseMutex.default.idle = true;
            MongooseMutex.default.timeLimit = weirdTimeLimit;
            MongooseMutex.default.promiseType = promiseType;

            var promises = [];

            try {
                var mutexA = new MongooseMutex(slug + 'a');
                mutexA.idle.should.be.true;
                mutexA.timeLimit.should.equal(weirdTimeLimit);
                mutexA.claim();
                mutexA.promise.should.be.instanceOf(promiseType);
                promises.push(mutexA.free().catch(util.nothing));
            } catch(err) {
                throw err;
            } finally {
                // If the defaults are changed then tests may need to be adjusted - be prepared.
                MongooseMutex.default = defaults;
                // Set the defaults to what's preferable for testing here.
                MongooseMutex.default.timeLimit = mutexTimeLimit;
            }

            var mutexB = new MongooseMutex(slug + 'b');
            mutexB.idle.should.be.false;
            mutexB.timeLimit.should.equal(mutexTimeLimit);
            mutexB.promise.should.be.instanceOf(RSVP.Promise);
            promises.push(mutexB.free().catch(util.nothing));

            var mutexC = new MongooseMutex(slug + 'c', { idle: true, timeLimit: weirdTimeLimit, promiseType: promiseType });
            mutexC.idle.should.be.true;
            mutexC.timeLimit.should.equal(weirdTimeLimit);
            mutexC.claim();
            mutexC.promise.should.be.instanceOf(promiseType);
            promises.push(mutexC.free().catch(util.nothing));

            return RSVP.all(promises);
        });
    });
    
    describe('#claim()', function() {
        it('should update and return .promise', function() {
            var mutex = new MongooseMutex('n/a', { idle: true });
            
            var promise = mutex.claim();
            promise.should.equal(mutex.promise);

            return promise
                .then(mutex.free)
                .then(function() {
                    promise = mutex.claim();
                    promise.should.equal(mutex.promise);

                    return promise.then(mutex.free).catch(util.nothing);
                })
                .catch(util.allErrors);
        });
        
        it('should correctly create a document in the "MongooseMutex" collection', function() {
            var slug = 'createTest',
                numTests = 3,
                mutex = new MongooseMutex(slug, { idle: true });
            
            var previousTimestamp;
            function checkMutex() {
                return new RSVP.Promise(function(resolve) {
                    mutex._model.findOne({ slug: slug }, function(err, doc) {
                        should.not.exist(err);
                        should.exist(doc);
                        
                        doc.timestamps.should.be.an.instanceOf(Array).and.have.lengthOf(1);
                        doc.timestamps[0].should.be.an.instanceOf(String).and.not.equal(previousTimestamp);
                        
                        var previousTimestamp = stamp = doc.timestamps[0];
                        var split = stamp.indexOf('-');
                        split.should.not.equal(-1);
                        
                        var rand = stamp.split(0, split);
                        parseInt(rand, 10).should.not.be.NaN;

                        stamp = parseInt(stamp.slice(split + 1));
                        stamp.should.not.be.NaN;
                        stamp.should.be.greaterThan(_.now());
                        stamp.should.be.lessThan(_.now() + mutex.timeLimit);
                        
                        resolve();
                    });
                });
            }

            var promise = RSVP.resolve();
            for(var i = numTests; i != 0; --i) {
                promise = promise
                    .then(mutex.claim)
                    .then(checkMutex)
                    .then(i === 1
                        ? function() { return mutex.free().catch(util.nothing); }
                        : mutex.free
                    );
            }

            return promise.catch(util.allErrors);
        });
        
        it('should remove it\'s document from the "MongooseMutex" collection after being #free()d', function() {
            var slug = 'removeTest',
                mutex = new MongooseMutex(slug);
            
            function checkMutex(shouldExist) {
                return function() {
                    return new RSVP.Promise(function(resolve) {
                        mutex._model.findOne({ slug: slug }, function(err, doc) {
                            should.not.exist(err);

                            if(shouldExist) should.exist(doc);
                            else            should.not.exist(doc);
                            
                            resolve();
                        });
                    });
                }
            }

            mutex.promise
                .then(checkMutex(true))
                .then(mutex.free)
                .then(checkMutex(false))
                .catch(util.allErrors);
        });
        
        it('should provide mutual exclusion under the same slug', function() {
            var slug = 'mutexTest',
                numMutexes = 4,
                mutexPromises = _.map(_.range(numMutexes), function(delay) {
                    return new RSVP.Promise(function(resolve) {
                        // A delay must be used because if they all happen 'simultaneously' (or immediately after
                        // one another) then they may all use the same time and all be rejected.
                        setTimeout(function() {
                            resolve(new MongooseMutex(slug));
                        }, delay * 5);
                    });
                });
            
            var resolved = 0;
            
            return RSVP.all(_.map(mutexPromises, function(mutexPromise) {
                return mutexPromise.then(function(mutex) {
                    return mutex.promise
                        .then(function(free) {
                            resolved++;
                            return free;
                        }, function(err) {
                            // TODO (use should and be careful)
                            if((err && err.message || err) != 'Failed to acquire mutual exclusion')
                                throw err;
                        });
                });
            })).then(function(frees) {
                resolved.should.equal(1);
                
                return RSVP.all(_.map(frees, function(free) {
                    return free ? free().catch(util.nothing) : RSVP.resolve();
                }));
            }).catch(util.allErrors);
        });
        
        it('should not lock mutexes under different slugs', function() {
            var slug = 'dontLockTest',
                numMutexes = 4,
                mutexPromises = _.map(_.range(numMutexes), function(i) { return new MongooseMutex(slug + i).promise; });
            
            return RSVP.all(mutexPromises)
                .then(function(frees) {
                    return RSVP.all(_.map(frees, function(free) {
                        return free().catch(util.nothing);
                    }));
                })
                .catch(util.allErrors);
        });
        
        it('should remove it\'s timestamp from the "MongooseMutex" collection after rejection', function() {
            var slug = 'failRemoveTest',
                mutex = new MongooseMutex(slug),
                numTests = 3,
                failingMutexes;

            return mutex.promise
                .then(function() {
                    return new RSVP.Promise(function(resolve) {
                        mutex._model.findOne({ slug: slug }, function(err, doc) {
                            should.not.exist(err);
                            should.exist(doc);

                            doc.timestamps.should.be.an.instanceOf(Array).and.have.lengthOf(1);
                            doc.timestamps[0].should.be.an.instanceOf(String);

                            resolve(doc.timestamps[0]);
                        });
                    });
                })
                .then(function(originalTimestamp) {
                    failingMutexes = _.map(_.range(numTests), function() { return new MongooseMutex(slug); });

                    return RSVP.all(_.map(failingMutexes), function(mutex) {
                        return mutex.promise.then(function() {
                            // TODO (use should somehow so it will be thrown as an assertion)
                            throw new Error('Mutex should have failed');
                        }, function(err) {
                            // TODO (use should)
                            if((err && err.message || err) != 'Failed to acquire mutual exclusion')
                                throw err;
                        });
                    }).then(function() {
                        return new RSVP.Promise(function(resolve) {
                            // For some reason we need to use a timeout here, otherwise some old values would still
                            // be present in the document's timestamp (even though the promise was only resolved after
                            // the update query was complete... maybe some caching thing).
                            // TODO (investigate)
                            setTimeout(function() {
                                mutex._model.findOne({ slug: slug }, function(err, doc) {
                                    should.not.exist(err);
                                    should.exist(doc);
                                    
                                    doc.timestamps.should.be.an.instanceOf(Array).and.have.lengthOf(1);
                                    doc.timestamps[0].should.be.an.instanceOf(String).and.equal(originalTimestamp);
                                    
                                    resolve();
                                });
                            }, 100);
                        });
                    })
                })
                .then(function() { return mutex.free().catch(util.nothing); })
                .catch(util.allErrors);
        });
        
        it('should not be rejected if a clashing timestamp has expired', function() {
            var slug = 'timeLimitTest',
                numTests = 3,
                timeLimit = parseInt(mutexTimeLimit / numTests),
                mutex = new MongooseMutex(slug, { idle: true, timeLimit: timeLimit });

            return _.reduce(_.range(numTests + 1), function(previousTimestampPromise) {
                return previousTimestampPromise.then(function(previousTimestamp) {
                    return new RSVP.Promise(function(resolve, reject) {
                        setTimeout(function() {
                            mutex.claim().then(function() {
                                mutex._model.findOne({ slug: slug }, function(err, doc) {
                                    should.not.exist(err);
                                    should.exist(doc);

                                    doc.timestamps.should.be.an.instanceOf(Array).and.have.lengthOf(1);
                                    doc.timestamps[0].should.be.an.instanceOf(String).and.not.equal(previousTimestamp);

                                    mutex = new MongooseMutex(slug, { idle: true, timeLimit: timeLimit });

                                    resolve(doc.timestamps[0]);
                                });
                            }).catch(reject);
                        }, previousTimestamp ? timeLimit : 0); // Don't timeout if it's the first mutex (i.e. previousTimestamp === null).
                    });
                });
            }, RSVP.resolve()).catch(util.allErrors);
        });

        it('should throw if .idle != true', function() {
            var mutex = new MongooseMutex('n/a');
            
            var checkThrow = function() {
                (function() {
                    mutex.claim();
                }).should.throw('Cannot claim when not idle');
            };
            checkThrow();
            
            mutex.promise
                .then(mutex.free)
                .then(function() {
                    mutex.claim();
                    checkThrow();
                    
                    return mutex.promise
                        .then(checkThrow)
                        .then(function() { return mutex.free().catch(util.nothing); });
                })
                .catch(util.allErrors);
        });
    });
    
    describe('#free()', function() {
        it('should be exactly equal to the free parameter from .promise', function() {
            var mutex = new MongooseMutex('n/a');
            
            mutex.promise
                .then(function(free) {
                    mutex.free.should.be.exactly(free);
                    
                    return free().catch(util.nothing);
                })
                .catch(util.allErrors);
        });
        
        it('should throw if .idle == true', function() {
            var mutex = new MongooseMutex('n/a', { idle: true });
            
            var checkThrow = function() {
                (function() {
                    mutex.free();
                }).should.throw('Cannot free idle mutex');
            };
            checkThrow();
            
            mutex.claim()
                .then(mutex.free)
                .then(checkThrow)
                .catch(util.allErrors);
        });
    });
    
    describe('.idle', function() {
        it('should initially be true if options.idle == true', function() {
            var mutex = new MongooseMutex('n/a', { idle: true });
            mutex.idle.should.be.true;
        });
        
        it('should not initially be true if options.idle != true', function() {
            var mutex = new MongooseMutex('n/a');
            mutex.idle.should.be.false;
            
            return mutex.promise.then(mutex.free).catch(util.nothing);
        });
        
        it('should be correct before and after #claim() and #free() if options.idle == true', function() {
            var mutex = new MongooseMutex('n/a', { idle: true });
            
            mutex.claim();
            mutex.idle.should.be.false;
            
            return mutex.promise
                .then(function(free) {
                    mutex.idle.should.be.false;
                    return free();
                })
                .then(function() { mutex.idle.should.be.true; })
                .catch(util.allErrors);
        });
        
        it('should be correct before and after #free() if options.idle != true', function() {
            var mutex = new MongooseMutex('n/a');
            
            return mutex.promise
                .then(function(free) {
                    mutex.idle.should.be.false;
                    return free();
                })
                .then(function() { mutex.idle.should.be.true; })
                .catch(util.allErrors);
        });
    });
    
    after(function() {
        mongoose.disconnect();
    });
});
