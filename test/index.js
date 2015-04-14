var should = require('should'),
    RSVP = require('rsvp'),
    mongoose = require('mongoose'),
    _ = require('lodash'),
    
    MongooseMutex = require('../index'),
    util = require('./lib/util');

mongoose.connect('mongodb://localhost/test');

describe('MongooseMutex', function() {
    beforeEach(function(done) {
        var total = Object.keys(mongoose.connection.collections).length;
        if(total === 0) return done();

        var removed = 0;
        for(var i in mongoose.connection.collections) {
            mongoose.connection.collections[i].remove(function() {
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
            MongooseMutex.connection = mongoose;
            
            (function() {
                new MongooseMutex('n/a', { idle: true });
            }).should.not.throw();
        });
    });
    
    describe('#go()', function() {
        it('should update and return .promise', function() {
            var mutex = new MongooseMutex('n/a', { idle: true });
            
            var promise = mutex.go();
            promise.should.equal(mutex.promise);
            
            return promise
                .then(mutex.free)
                .catch(util.connError())
                .then(function() {
                    promise = mutex.go();
                    promise.should.equal(mutex.promise);
                    
                    return promise.then(mutex.free).catch(util.nothing);
                });
        });
        
        it('should create a correct document in the "_mutex" collection when locked', function() {
            var id = 'createTest',
                mutex = new MongooseMutex(id);
            
            return mutex.promise
                .catch(util.connError)
                .then(function() {
                    return new RSVP.Promise(function(resolve) {
                        mutex._model.findOne({ _id: id }, function(err, doc) {
                            should.not.exist(err);
                            should.exist(doc);
                            
                            doc.timestamps.should.be.an.instanceOf('Array').and.have.lengthOf(1);
                            doc.timestamps[0].should.be.an.instanceOf('string');
                            
                            var stamp = doc.timestamps[0];
                            var split = stamp.indexOf('-');
                            split.should.not.equal(-1);
                            
                            var rand = stamp.split(0, split);
                            parseInt(rand, 10).should.not.be.NaN;
                            
                            stamp = stamp.slice(split + 1);
                            (function() {
                                stamp = new Date(stamp);
                            }).should.not.throw();
                            stamp.should.be.greaterThan(Date.now());
                            
                            resolve();
                        });
                    }).then(mutex.free)
                        .catch(util.assertsOnly);
                });
        });
        
        it('should remove it\'s timestamp from the "_mutex" collection after being free()d', function() {
            var id = 'removeTest',
                mutex = new MongooseMutex(id);
            
            mutex.promise
                .then(mutex.free)
                .catch(util.connError)
                .then(function() {
                    return new RSVP.Promise(function(resolve) {
                        mutex._model.findOne({ _id: id }, function(err, doc) {
                            should.not.exist(err);
                            should.exist(doc);
                            
                            doc.timestamps.should.be.an.instanceOf('Array').and.have.lengthOf(0);
                            
                            resolve();
                        });
                    });
                });
        });
        
        it('should provide mutual exclusion under the same ID', function() {
            var id = 'mutexTest',
                numMutexes = 4,
                mutexes = _.map(_.range(numMutexes), function() { return new MongooseMutex(id); });
            
            var resolved = 0;
            
            return RSVP.all(_.map(mutexes, function(mutex) {
                return mutex.promise
                    .then(function(free) {
                        resolved++;
                        return free;
                    }, function(err) {
                        // TODO (use should)
                        if((err && err.message || err) != 'Failed to acquire mutual exclusion')
                            throw err;
                    });
            })).then(function(frees) {
                resolved.should.equal(1);
                
                return _.map(frees, function(free) {
                    return free ? free().catch(util.nothing) : RSVP.resolve();
                });
            });
        });
        
        it('should not lock mutexes under different IDs', function() {
            var id = 'dontLockTest',
                numMutexes = 4,
                mutexPromises = _.map(_.range(numMutexes), function(i) { return new MongooseMutex(id + i).promise; });
            
            return RSVP.all(mutexPromises)
                .catch(util.connError)
                .then(function(frees) {
                    return _.map(frees, function(free) {
                        return free().catch(util.nothing);
                    });
                });
        });
        
        it('should remove it\'s timestamp from the "_mutex" collection after rejection', function() {
            var id = 'failRemoveTest',
                mutex = new MongooseMutex(id),
                numTests = 3,
                failingMutexes = _.map(_.range(numTests), function() { return new MongooseMutex(id); });
            
            return mutex.promise
                .catch(util.connError)
                .then(function() {
                    return RSVP.all(_.map(failingMutexes), function(mutex) {
                        return mutex.promise.then(function() {
                            // TODO (use should somehow)
                            throw new Error('Mutex should have failed');
                        }, function(err) {
                            // TODO (use should)
                            if((err && err.message || err) != 'Failed to acquire mutual exclusion')
                                throw err;
                        });
                    }).then(function() {
                        return new RSVP.Promise(function(resolve) {
                            mutex._model.findOne({ _id: id }, function(err, doc) {
                                should.not.exist(err);
                                should.exist(doc);
                                
                                // TODO (finish test)
                                
                                resolve();
                            });
                        });
                    })
                })
                .then(mutex.free)
                .catch(util.assertsOnly);
        });
        
        it('should throw if .idle != true', function() {
            var mutex = new MongooseMutex('n/a');
            
            var checkThrow = function() {
                (function() {
                    mutex.go();
                }).should.throw('Cannot go when not idle');
            };
            checkThrow();
            
            mutex.promise
                .then(mutex.free)
                .catch(util.connError)
                .then(function() {
                    mutex.go();
                    checkThrow();
                    
                    return mutex.promise
                        .then(mutex.free)
                        .catch(util.nothing);
                });
        });
    });
    
    describe('.free', function() {
        it('should be exactly equal to the free parameter from .promise', function() {
            var mutex = new MongooseMutex('n/a');
            
            mutex.promise
                .catch(util.connError)
                .then(function(free) {
                    mutex.free.should.be.exactly(free);
                    
                    return free().catch(util.nothing);
                });
        });
        
        it('should throw if .idle == true', function() {
            var mutex = new MongooseMutex('n/a', { idle: true });
            
            var checkThrow = function() {
                (function() {
                    mutex.free();
                }).should.throw('Cannot free idle mutex');
            };
            checkThrow();
            
            mutex.go()
                .then(mutex.free)
                .catch(util.connError)
                .then(checkThrow);
        });
    });
    
    describe('.idle', function() {
        it('should initially be true if options.idle == true', function() {
            var mutex = new MongooseMutex('n/a', { idle: true });
            mutex.idle.should.be.true;
        });
        
        it('should not initially be true if options.idle != true', function() {
            var mutex = new MongooseMutex('n/a');
            mutex.idle.should.not.be.true;
            
            return mutex.promise.then(mutex.free).catch(util.nothing);
        });
        
        it('should be correct before and after .go() and free() if options.idle == true', function() {
            var mutex = new MongooseMutex('n/a', { idle: true });
            
            mutex.go();
            mutex.idle.should.be.false;
            
            return mutex.promise
                .then(function(free) {
                    mutex.idle.should.be.false;
                    return free();
                })
                .catch(util.connError)
                .then(function() { mutex.idle.should.be.true; });
        });
        
        it('should be correct before and after free() if options.idle != true', function() {
            var mutex = new MongooseMutex('n/a');
            
            return mutex.promise
                .then(function(free) {
                    mutex.idle.should.be.false;
                    return free();
                })
                .catch(util.connError)
                .then(function() { mutex.idle.should.be.true; });
        });
    });
    
    after(function() {
        mongoose.disconnect();
    });
});
