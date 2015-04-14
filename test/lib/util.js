var should = require('should'),
    RSVP = require('rsvp');

function isAssertionError(err) {
    return Boolean(err.toString().match(/^AssertionError/));
};

var m = {
    // Forward no error (useful if only connection errors would get through,
    // but we've tested everything we need to so we don't want to see these errors)
    nothing: function() {},
    
    // Only forward on assertion errors - ignore connection errors
    assertsOnly: function(err) {
        if(isAssertionError(err))
            throw err;
    },
    
    // If the error is an assertion error, forward that. Otherwise assume it's a
    // connection error and provide a more appropriate description (since the
    // one from the error on it's own may be confusing and useless)
    connError: function(err) {
        if(isAssertionError(err))
            throw err;
        
        throw new Error('Error caught when working the mutex: ' + JSON.stringify(err));
    }
};

module.exports = m;