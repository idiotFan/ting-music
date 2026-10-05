//! Mutex access that survives a panicked holder: the guarded state stays usable.
use std::sync::{Mutex, MutexGuard, PoisonError};

pub trait Locked<T> {
    fn locked(&self) -> MutexGuard<'_, T>;
}

impl<T> Locked<T> for Mutex<T> {
    fn locked(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::Locked;
    use std::sync::{Arc, Mutex};

    #[test]
    fn poisoned_mutex_stays_usable() {
        let shared = Arc::new(Mutex::new(1));
        let clone = shared.clone();
        let _ = std::thread::spawn(move || {
            let _guard = clone.lock().unwrap();
            panic!("poison");
        })
        .join();
        assert!(shared.is_poisoned());
        *shared.locked() += 1;
        assert_eq!(*shared.locked(), 2);
    }
}
